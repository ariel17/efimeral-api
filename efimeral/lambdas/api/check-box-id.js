const { EC2 } = require("@aws-sdk/client-ec2");
const { ECS } = require("@aws-sdk/client-ecs");
const { ServiceDiscovery } = require("@aws-sdk/client-servicediscovery")
const Sentry = require("@sentry/serverless");


Sentry.AWSLambda.init({
  dsn: process.env.LAMBDAS_SENTRY_DSN,
  tracesSampleRate: 0.1,
  timeoutWarningLimit: 40000,
});

const ports = {
  'box-vscode': 8080,
  'box-alpine': 8080,
  'box-ubuntu': 8080,
}

exports.handler = Sentry.AWSLambda.wrapHandler(async (event, context) => {
  let headers = {
      "Access-Control-Allow-Headers" : "Content-Type",
      "Access-Control-Allow-Methods": "POST"
  }
  if (process.env.CORS_DISABLED === "true") {
      headers["Access-Control-Allow-Origin"] = "*"
  }

  const ecs = new ECS();
  
  try {
    const task = await getRunningTaskById(process.env.CLUSTER_ARN, event.pathParameters.box_id, ecs);
    if (task === undefined) {
      return {
        statusCode: 404,
        headers: headers,
        body: JSON.stringify({
          message: 'Not found',
        }),
      };
    }

    const networkData = await getNetworkData(task);

    const sd = new ServiceDiscovery();
    const registrationResponse = await sd.registerInstance({
      ServiceId: process.env.CLOUDMAP_ID,
      InstanceId: event.pathParameters.box_id,
      Attributes: {
          AWS_INSTANCE_IPV4: networkData.Association.PublicIp,
      }
    });
    console.log(`Registration response: ${JSON.stringify(registrationResponse)}`);

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({
        message: 'Box is ready',
        url: getContainerURL(networkData, task),
      }),
    };

  } catch(e) {
    console.error(e, e.stack)
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'Error checking box',
        error: `${e}`,
      })
    };
  };
});

async function getRunningTaskById(clusterArn, taskId, ecs) {
  const params = {
    cluster: clusterArn,
    tasks: [taskId,]
  };
  var tasks = await ecs.describeTasks(params);
  console.log(`Tasks description: ${JSON.stringify(tasks)}`);
 
  if (tasks.tasks.length > 0) {
    let task = tasks.tasks[0];
    if (task.lastStatus === 'RUNNING') {
      console.log(`Task id=${taskId} is running :)`);
      return task;
    }
  }

  return undefined;
}

async function getNetworkData(task) {
  const details = task.attachments[0].details;
  let eni = '';
  for (let i = 0; i < details.length; i++) {
    if (details[i].name === 'networkInterfaceId') {
      eni = details[i].value;
      break;
    }
  }
  
  if (eni === '') {
    throw 'Cannot obtain network interface ID';
  }
  
  const params = {
    NetworkInterfaceIds: [eni],
  }

  const ec2 = new EC2();
  const data = await ec2.describeNetworkInterfaces(params);
  console.log(`Network data: ${JSON.stringify(data)}`);
  
  return data.NetworkInterfaces[0];
}

function getContainerURL(networkData, task) {
  return `http://${networkData.Association.PublicDnsName}:${ports[task.containers[0].name]}`
}