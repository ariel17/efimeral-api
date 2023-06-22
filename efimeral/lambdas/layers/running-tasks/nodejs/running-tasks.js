export const boxPorts = {
  'box-vscode': 8080,
  'box-alpine': 8080,
  'box-ubuntu': 8080,
}

export async function getRunningTaskById(clusterArn, taskId, ecs) {
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

export async function getNetworkData(task, ec2) {
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

  const data = await ec2.describeNetworkInterfaces(params);
  console.log(`Network data: ${JSON.stringify(data)}`);
  
  return data.NetworkInterfaces[0];
}