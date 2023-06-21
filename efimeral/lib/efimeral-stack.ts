import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodeJS from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';


export const ecrRepositoyName = 'efimeral-boxes';
export const containerTimeoutMinutes = 10;
export const domain = 'efimeral.ar';
export const apiSubdomain = `api.${domain}`;
export const boxesSubdomain = `boxes.${domain}`;
export const images = [
  {tag: 'alpine', ecr: true, compatibility: ecs.Compatibility.FARGATE, privileged: false, port: 8080, portRange: undefined, image: '', environment: {}},
  {tag: 'ubuntu', ecr: true, compatibility: ecs.Compatibility.FARGATE, privileged: false, port: 8080, portRange: undefined, image: '', environment: {}},
  {tag: 'vscode', ecr: true, compatibility: ecs.Compatibility.FARGATE, privileged: false, port: 8080, portRange: undefined, image: '', environment: {}},
  {tag: 'dind', ecr: true, compatibility: ecs.Compatibility.EC2, privileged: true, port: undefined, portRange:{startPort: 8080, endPort: 8090}, image: '', environment: {}},
  // {tag: 'other', ecr: false, compatibility: ecs.Compatibility.FARGATE, privileged: false, port: 8000, portRange: undefined, image: 'codercom/code-server', environment: {}},
]

export class APIStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const repository = new ecr.Repository(this, ecrRepositoyName, {
      repositoryName: ecrRepositoyName,
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const vpc = new ec2.Vpc(this, 'boxes-vpc', {
      maxAzs: 3,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'boxes-public-subnet',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    const sg = new ec2.SecurityGroup(this, 'boxes-vpc-sg', {
      vpc: vpc,
      allowAllOutbound: true,
      description: 'Security group for boxes VPC',
    });
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.allTcp(), 'Allow access from any IPv4 to all ports');
    sg.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.allTcp(), 'Allow access from any IPv6 to all ports');

    const cluster = new ecs.Cluster(this, 'boxes-cluster', {
      vpc: vpc,
      clusterName: 'boxes-cluster',
      containerInsights: true,
      capacity: {
        instanceType: new ec2.InstanceType('t2.micro'),
        minCapacity: 0,  // CHANGE THIS to 1 to support EC2 tasks
        maxCapacity: 0,  // CHANGE THIS to 1 to support EC2 tasks
      },
    });    

    const tasks: { [key: string]: ecs.TaskDefinition } = {};
    const taskDetails: { [key: string]: any} = {};
    images.forEach(tag => {
      const task = new ecs.TaskDefinition(this, `box-task-${tag.tag}`, {
        compatibility: tag.compatibility,
        cpu: '256',
        memoryMiB: '512',
      });

      let image;
      if (tag.ecr) {
        image = ecs.ContainerImage.fromEcrRepository(repository, tag.tag);
      } else {
        image = ecs.ContainerImage.fromRegistry(`${tag.image}:latest`);
      }

      const container = task.addContainer(`box-${tag.tag}`, {
        image: image,
        cpu: 1,
        memoryReservationMiB: 512,
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: `box-${tag.tag}`,
          logRetention: logs.RetentionDays.ONE_WEEK,
        }),
        environment: tag.environment,
        privileged: tag.privileged,
      });
    
      if (tag.port !== undefined) {
        container.addPortMappings({
          containerPort: tag.port,
          protocol: ecs.Protocol.TCP,
        });
      }
    
      if (tag.portRange !== undefined) {
        const portMappings: ecs.PortMapping[] = [];
        for (let i = tag.portRange.startPort; i <= tag.portRange.endPort; i++) {
          portMappings.push({
            containerPort: i,
            protocol: ecs.Protocol.TCP,
          });
        }
        container.addPortMappings(...portMappings);
      }

      tasks[tag.tag] = task;
      taskDetails[tag.tag] = {
        arn: task.taskDefinitionArn,
        launchType: tag.compatibility === ecs.Compatibility.FARGATE ? 'FARGATE' : 'EC2',
      };
    });

    const sentryDSN = secretsmanager.Secret.fromSecretNameV2(
      this, 'sentry-dsn', 'lambdasSentryDSN'
    ).secretValue.unsafeUnwrap().toString();

    const fnApiCreateBoxHandler = new lambdaNodeJS.NodejsFunction(this, 'api-create-box', {
      description: 'Creates new instances on Fargate cluster and returns the task ID as box ID.',
      runtime: lambda.Runtime.NODEJS_18_X,
      entry: './lambdas/api/create-box.js',
      allowPublicSubnet: true,
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        LAMBDAS_SENTRY_DSN: sentryDSN,
        CORS_DISABLED: "true",
        CLUSTER_ARN: cluster.clusterArn,
        MAX_ALLOWED_RUNNING_TASKS: "10",
        TASK_DETAILS: JSON.stringify(taskDetails),
        DEFAULT_TAG: 'alpine',
        AVAILABLE_TAGS: JSON.stringify(images.map(tag => tag.tag)),
        SUBNET_ID: vpc.publicSubnets[0].subnetId,
        SECURITY_GROUP_ID: sg.securityGroupId,
      },
      bundling: {
        esbuildArgs: {
          '--alias:@layer': './lambdas/layers/listtasks/nodejs',
        },
        nodeModules: [
          '@sentry/serverless',
        ],
      },
    });

    images.forEach(tag => tasks[tag.tag].grantRun(fnApiCreateBoxHandler));

    const fnApiCreateBoxPolicy = new iam.PolicyStatement({
      actions: ['ecs:RunTask', 'ecs:ListTasks'],
      resources: ["*"],
      effect: iam.Effect.ALLOW,
    });
    fnApiCreateBoxHandler.addToRolePolicy(fnApiCreateBoxPolicy);

    const ns = new servicediscovery.PublicDnsNamespace(this, 'boxes-namespace', {
      name: boxesSubdomain,
      description: 'Namespace for boxes',
    });

    const parts = ns.publicDnsNamespaceId.split('/')
    const cloudmapId = parts[parts.length - 1];

    const fnApiCheckBoxIdHandler = new lambdaNodeJS.NodejsFunction(this, 'api-check-box-id', {
      description: 'Checks RUNNING state for box ID and returns its public URL if exists',
      runtime: lambda.Runtime.NODEJS_18_X,
      entry: './lambdas/api/check-box-id.js',
      allowPublicSubnet: true,
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        LAMBDAS_SENTRY_DSN: sentryDSN,
        CORS_DISABLED: "true",
        CLUSTER_ARN: cluster.clusterArn,
        CLOUDMAP_ID: cloudmapId,
      },
      bundling: {
        esbuildArgs: {
          '--alias:@layer': './lambdas/layers/listtasks/nodejs',
        },
        nodeModules: [
          '@sentry/serverless',
        ],
      },
    });

    const fnApiCheckBoxIdPolicy = new iam.PolicyStatement({
      actions: ['ecs:DescribeTasks', 'ec2:DescribeNetworkInterfaces', 'servicediscovery:GetService', 'servicediscovery:RegisterInstance'],  //, 'route53:ChangeResourceRecordSets'],
      resources: ["*"],
      effect: iam.Effect.ALLOW,
    });
    fnApiCheckBoxIdHandler.addToRolePolicy(fnApiCheckBoxIdPolicy);

    const api = new apigateway.RestApi(this, "boxes-api", {
      restApiName: "Efimeral API service",
      description: "Linux boxes on demand.",
      defaultCorsPreflightOptions: {
        allowHeaders: [
          'Content-Type',
        ],
        allowMethods: ['OPTIONS', 'POST', 'GET'],
        allowOrigins: ['http://localhost:3000', 'http://efimeral.ar', 'https://efimeral.ar'],
      },
    });

    const createBoxesIntegration = new apigateway.LambdaIntegration(fnApiCreateBoxHandler, {
      requestTemplates: { "application/json": '{ "statusCode": "201" }' }
    })
    const boxesResource = api.root.addResource('boxes');
    boxesResource.addMethod('POST', createBoxesIntegration);

    const checkBoxIdIntegration = new apigateway.LambdaIntegration(fnApiCheckBoxIdHandler, {
      requestTemplates: { "application/json": '{ "statusCode": "200" }' }
    })
    const boxResource = boxesResource.addResource('{box_id}');
    boxResource.addMethod('GET', checkBoxIdIntegration);
  
    new cdk.CfnOutput(this, 'apiUrl', {value: api.url});

    const fnKiller = new lambdaNodeJS.NodejsFunction(this, 'lambda-scheduled-killer', {
      description: 'Destroys timeouted containers in RUNNING state.',
      runtime: lambda.Runtime.NODEJS_18_X,
      entry: './lambdas/scheduled/killer.js',
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        CLUSTER_ARN: cluster.clusterArn,
        CONTAINER_TIMEOUT_MINUTES: `${containerTimeoutMinutes}`,
        LAMBDAS_SENTRY_DSN: sentryDSN,
      },
      bundling: {
        esbuildArgs: {
          '--alias:@layer': './lambdas/layers/listtasks/nodejs',
        },
        nodeModules: [
          '@sentry/serverless',
        ],
      },
    });

    const fnKillerPolicy = new iam.PolicyStatement({
      actions: ['ecs:ListTasks', 'ecs:DescribeTasks', 'ecs:StopTask'],
      resources: ["*"],
      effect: iam.Effect.ALLOW,
    });
    fnKiller.addToRolePolicy(fnKillerPolicy);

    const killerRule = new events.Rule(this, 'KillerScheduledRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
    });

    killerRule.addTarget(new targets.LambdaFunction(fnKiller));


    // API Subdomain --------------------

    const webZone = route53.PublicHostedZone.fromHostedZoneAttributes(this, 'lookup-web-hosted-zone', {
      zoneName: domain,
      hostedZoneId: String(process.env.WEB_HOSTED_ZONE_ID),
    });

    const certificate = new acm.Certificate(this, 'api-certificate', {
      domainName: apiSubdomain,
      validation: acm.CertificateValidation.fromDns(webZone),
    });
  
    const dn = new apigateway.DomainName(this, 'api-subdomain', {
      domainName: apiSubdomain,
      certificate: certificate,
      endpointType: apigateway.EndpointType.REGIONAL,
    });
  
    dn.addBasePathMapping(api, {
      basePath: 'prod',
    })

    new route53.ARecord(this, 'api-subdomain-alias-record', {
      zone: webZone,
      recordName: apiSubdomain,
      target: route53.RecordTarget.fromAlias(new route53Targets.ApiGatewayDomain(dn)),
    });
  }
}
