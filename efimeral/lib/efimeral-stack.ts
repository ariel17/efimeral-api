import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elb2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as path from 'path';
import * as assets from 'aws-cdk-lib/aws-s3-assets';


export const ecrResourceName = 'boxes-repository';
export const ecrRepositoyName = 'efimeral-boxes';
export const vpcName = 'public-boxes-vpc';
export const ecsClusterName = 'boxes-cluster';
export const ecsClusterInstanceType = 't2.nano';
export const ecsTaskName = 'box-instantiation';
export const ecsMinCapacity = 0;
export const ecsMaxCapacity = 10;
export const containerName = 'box';
export const defaultTagImage = 'alpine';
export const taskCPUs = '256'
export const taskMemory = '512'
export const containerCPUs = 1;
export const containerMemory = 512;
export const containerStopTimeout = 7200;  // 2 hs
export const containerPort = 8080;
export const ecsLoadBalancerName = 'efimeral-load-balancer';
export const ecsLoadBalancerMemoryLimit = 512;
export const ecsLoadBalancerCPUs = 256;


export class EfimeralStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const repository = new ecr.Repository(this, ecrRepositoyName, {
      repositoryName: ecrRepositoyName,
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const vpc = new ec2.Vpc(this, vpcName, {
      maxAzs: 3,
      subnetConfiguration: [
        {
          name: vpcName,
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    const cluster = new ecs.Cluster(this, ecsClusterName, {
      clusterName: ecsClusterName,
      containerInsights: true,
      capacity: {
        instanceType: new ec2.InstanceType(ecsClusterInstanceType),
        minCapacity: ecsMinCapacity,
        maxCapacity: ecsMaxCapacity,
      },
      vpc: vpc
    });

    const task = new ecs.TaskDefinition(this, ecsTaskName, {
      compatibility: ecs.Compatibility.EC2_AND_FARGATE,
      cpu: taskCPUs,
      memoryMiB: taskMemory,
    });
    task.addContainer(containerName, {
      image: ecs.ContainerImage.fromEcrRepository(repository, defaultTagImage),
      cpu: containerCPUs,
      memoryReservationMiB: containerMemory,
      portMappings: [
        {
          containerPort: containerPort,
          protocol: ecs.Protocol.TCP,
        },
      ],
    });

    const ecsLoadBalancer = new ecsPatterns.ApplicationLoadBalancedEc2Service(this, ecsLoadBalancerName, {
      cluster: cluster,
      taskDefinition: task,
      cpu: ecsLoadBalancerCPUs,
      memoryLimitMiB: ecsLoadBalancerMemoryLimit,
      publicLoadBalancer: true,
      targetProtocol: elb2.ApplicationProtocol.HTTP,
      listenerPort: containerPort,
    });
    ecsLoadBalancer.targetGroup.configureHealthCheck({
      enabled: false,
    });

    const lambdaAsset = new assets.Asset(this, 'lambda-handler.zip', {
      path: path.join(__dirname, '../resources/lambda-handler.zip'),
    });

    const fn = new lambda.Function(this, 'lambda-handler', {
      allowPublicSubnet: true,
      handler: 'index.handler',
      code: lambda.Code.fromBucket(lambdaAsset.bucket, lambdaAsset.s3ObjectKey),  
      runtime: lambda.Runtime.NODEJS_16_X,
      environment: {
        TASK_DEFINITION_ARN: task.taskDefinitionArn,
        CLUSTER_ARN: cluster.clusterArn,
        SUBNET_ID: vpc.publicSubnets[0].subnetId,
        SECURITY_GROUP_ID: vpc.vpcDefaultSecurityGroup,
        CONTAINER_HARD_LIMIT_TIMEOUT: `${containerStopTimeout}`,
      },
      vpc,
    });
  }
}
