// Copyright 2016-2019, Pulumi Corporation.  All rights reserved.

import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config("airflow");
const dbPassword = config.requireSecret("dbPassword");

const vpc = new aws.ec2.DefaultVpc('default', { tags: { Name: 'Default VPC' } })

/*
const ubuntu = aws.ec2.getAmi({
  mostRecent: true,
  filters: [
      {
          name: "name",
          values: ["ubuntu/images/hvm-ssd/ubuntu-focal-20.04-amd64-server-*"],
      },
      {
          name: "virtualization-type",
          values: ["hvm"],
      },
  ],
  owners: ["099720109477"],
});

const launchConfiguration = new aws.ec2.LaunchConfiguration('airflow-launch', {
  namePrefix: 'teste-dan',
  imageId: ubuntu.then(ubuntu => ubuntu.id), //https://www.pulumi.com/registry/packages/aws/api-docs/ec2/launchconfiguration/
  instanceType: "t2.xlarge",
})

const autoScalingGroup = new aws.autoscaling.Group('airflow', {
  availabilityZones: zones.then(zones => zones.names),
  minSize: 4,
  maxSize: 4,
  launchConfiguration: launchConfiguration.name//'airflow-launch'
})


const capacityProvider = new aws.ecs.CapacityProvider('airflow-capacity-provider', {
  autoScalingGroupProvider:{
    autoScalingGroupArn:autoScalingGroup.arn,
  },
})
*/
const cidrs = ['172.31.112.0/20', '172.31.128.0/20', '172.31.144.0/20', '172.31.160.0/20'];
const zones = aws.getAvailabilityZones()
const subnets = zones.then(zones =>
  zones.names.map((name, index) =>

    new aws.ec2.Subnet(name, {
      vpcId: vpc.id,
      cidrBlock: cidrs[index],
      availabilityZone: name,
      tags: { Name: 'subnet_' + name, },
    })));

const securityGroupIds = [vpc.defaultSecurityGroupId]

const testRole = new aws.iam.Role("testRole", {
  assumeRolePolicy:JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "",
        Effect: "Allow",
        Principal: {
          Service: "ecs-tasks.amazonaws.com"
        },
        "Action": "sts:AssumeRole"
      }
    ]
  }),

  managedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',],
});

const cluster = new aws.ecs.Cluster('airflow-cluster', {
  configuration: {
    
  }
})

const clusterCapacityProviders = new aws.ecs.ClusterCapacityProviders("airflow-cluster-capacity-providers", {
    clusterName: cluster.name,
    capacityProviders: ['FARGATE'],//[capacityProvider.name],
    defaultCapacityProviderStrategies: [{
        base: 1,
        weight: 100,
        capacityProvider: 'FARGATE',//capacityProvider.name,
    }],
});



const subnetIds = subnets.then(nets => nets.map(n => n.id))
const dbSubnets = new aws.rds.SubnetGroup("dbsubnets", {
  subnetIds
});

const db = new aws.rds.Instance("postgresdb", {
  engine: "postgres",

  instanceClass: "db.t3.micro",
  allocatedStorage: 20,

  dbSubnetGroupName: dbSubnets.id,
  vpcSecurityGroupIds: securityGroupIds,

  name: "airflow",
  username: "airflow",
  password: dbPassword,

  skipFinalSnapshot: true,
});


const cacheSubnets = new aws.elasticache.SubnetGroup("cachesubnets", {
  subnetIds
});

const cacheCluster = new aws.elasticache.Cluster("cachecluster", { // 12.41 USD/month
  engine: "redis",

  nodeType: "cache.t2.micro",
  numCacheNodes: 1,

  subnetGroupName: cacheSubnets.id,
  securityGroupIds: securityGroupIds,
});


const hosts = pulumi.all([db.endpoint.apply(e => e.split(":")[0]), cacheCluster.cacheNodes[0].address]);
const environment = hosts.apply(([postgresHost, redisHost]) => [
  { name: "POSTGRES_HOST", value: postgresHost },
  { name: "POSTGRES_PASSWORD", value: dbPassword },
  { name: "REDIS_HOST", value: redisHost },
  { name: "EXECUTOR", value: "Celery" },
]);


const airflowLoadBalancer = new aws.lb.LoadBalancer("airflow-load-balancer", {subnets:subnetIds});

const controllerTargetGroup = new aws.lb.TargetGroup('controller-target-group', {
  port: 8080,
  protocol: 'HTTP',
  targetType:'ip',
  vpcId: vpc.id,
});

const airflowControllerListener = new aws.lb.Listener("airflow-controller-listener", {
  defaultActions: [{
    type: "forward",
    targetGroupArn: controllerTargetGroup.arn,
  }],
  loadBalancerArn: airflowLoadBalancer.arn,
  port: 8080,
  protocol: "HTTP",
});

const repo = new aws.ecr.Repository("repo", {
  forceDelete: true,
});
const webserverImage = new awsx.ecr.Image("webserver", {
  path: "./airflow-container",
  repositoryUrl: repo.repositoryUrl
})
const schedulerImage = new awsx.ecr.Image("scheduler", { repositoryUrl: repo.repositoryUrl, path: "./airflow-container" })

const serverSchedulerTaskDefinition = new aws.ecs.TaskDefinition('server-scheduler-task-definition', {
  family: 'my-special-family',
  taskRoleArn : testRole.arn,
  executionRoleArn: testRole.arn,
  requiresCompatibilities:['FARGATE'],
  cpu:"1024",
  memory:'2048',
  networkMode:'awsvpc',
  containerDefinitions: pulumi // https://www.pulumi.com/docs/concepts/inputs-outputs/#outputs-and-json
  .all(([webserverImage.imageUri, schedulerImage.imageUri,airflowControllerListener,environment]))
  .apply( ([serverUri,schedulerUri,listener,environment]) =>
   JSON.stringify([
    {
      name: "webserver",
      image: serverUri,
      memory: 128,
      portMappings: [{containerPort: 8080, hostPort: 8080,}],//[listener],
      environment: environment,
      command: ['webserver']
    },
    {
      name: "scheduler",
      image: schedulerUri,
      memory: 128,
      environment: environment,
      command: ['scheduler']
    },
  ]))
},)

const airflowController = new aws.ecs.Service('airflow-controller', {
  desiredCount: 1,
  cluster: cluster.arn,
  networkConfiguration:{
    assignPublicIp:true,
    subnets: subnetIds,
    securityGroups:securityGroupIds,
  },
  taskDefinition: serverSchedulerTaskDefinition.arn,
  loadBalancers:[{
    targetGroupArn: controllerTargetGroup.arn,
    containerName:'webserver',
    containerPort:8080,
  }],
})

const airflowerTargetGroup = new aws.lb.TargetGroup('airflower-target-group', {
  port: 5555,
  protocol: 'HTTP',
  vpcId: vpc.id,
  targetType:'ip',
});

const airflowerListener = new aws.lb.Listener("airflower-listener", {
  defaultActions: [{
    type: "forward",
    targetGroupArn: airflowerTargetGroup.arn
  }],
  loadBalancerArn: airflowLoadBalancer.arn,
  port: 5555,
  protocol: "HTTP",
});
const airflowerImage = new awsx.ecr.Image("notflower", { repositoryUrl: repo.repositoryUrl, path: "./airflow-container" })

const flowerTaskDefinition = new aws.ecs.TaskDefinition('flower-task-definition', {
  family: 'my-special-family',
  taskRoleArn : testRole.arn,
  executionRoleArn: testRole.arn,
  requiresCompatibilities:['FARGATE'],
  cpu:"1024",
  memory:'2048',
  networkMode:'awsvpc',
  containerDefinitions: pulumi.
  all([airflowerImage.imageUri, airflowerListener, environment])
  .apply(([image, listener, environment]) =>
    JSON.stringify([
    // If the container is named "flower", we create environment variables that start
    // with `FLOWER_` and Flower tries and fails to parse them as configuration.
    {
      name: "notflower",
      image: image,
      memory: 128,
      portMappings: [{containerPort: 5555, hostPort: 5555,}],//[listener]
      environment: environment,
      command: ['flower']
    }
  ]))
})

const airflower = new aws.ecs.Service('airflower', {
  cluster: cluster.arn,

  networkConfiguration:{
    assignPublicIp:true,
    subnets: subnetIds,
    securityGroups:securityGroupIds,
  },
  taskDefinition: flowerTaskDefinition.arn,
  loadBalancers:[{
    targetGroupArn:airflowerTargetGroup.arn,
    containerName: 'notflower',
    containerPort: 5555,
  }]
})

const workerImage = new awsx.ecr.Image("worker", { repositoryUrl: repo.repositoryUrl, path: "./airflow-container" })

const workerTaskDefinition = new aws.ecs.TaskDefinition('worker-task-definition', {
  family: 'my-special-family',
  taskRoleArn : testRole.arn,
  executionRoleArn: testRole.arn,
  requiresCompatibilities:['FARGATE'],
  cpu:"1024",
  memory:'2048',
  networkMode:'awsvpc',
  containerDefinitions:pulumi
  .all([workerImage.imageUri, environment])
  .apply( ([image, environment]) =>
    JSON.stringify([
    // If the container is named "flower", we create environment variables that start
    // with `FLOWER_` and Flower tries and fails to parse them as configuration.
    {
      name: "worker",
      image: image,
      memory: 1024,
      environment: environment,
      command: ['worker']
    }
  ]))
})

const airflowWorkers = new aws.ecs.Service("airflow-workers", {
  cluster: cluster.arn,

  networkConfiguration:{
    assignPublicIp:true,
    subnets: subnetIds,
    securityGroups:securityGroupIds,
  },
  desiredCount: 3,
  taskDefinition: workerTaskDefinition.arn
});

export let airflowEndpoint = airflowControllerListener.urn
export let flowerEndpoint = airflowerListener.urn
