// Copyright 2016-2019, Pulumi Corporation.  All rights reserved.

import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config("airflow");
const dbPassword = config.requireSecret("dbPassword");

const vpc = new aws.ec2.DefaultVpc('default', { tags: { Name: 'Default VPC' } })

const launchConfiguration = new aws.ec2.LaunchConfiguration('airflow-launch', {
  imageId: 'i-0c2f489b56ed0ac7f',
  instanceType: "t2.xlarge",
})

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

const autoScalingGroup = new aws.autoscaling.Group('airflow', {
  vpcZoneIdentifiers: cidrs,
  minSize: 4,
  maxSize: 4,
  launchConfiguration: 'airflow-launch'
})
const securityGroupIds = [vpc.defaultSecurityGroupId]
const cluster = new aws.ecs.Cluster('airflow-cluster', {})


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


const airflowLoadBalancer = new aws.lb.LoadBalancer("airflow-load-balancer", {});

const airflowControllerListener = new aws.lb.Listener("airflow-controller-listener", {
  defaultActions: [{
    type: "forward",
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
  containerDefinitions: JSON.stringify([
    {
      name: "webserver",
      image: webserverImage.imageUri,
      memory: 128,
      portMappings: [airflowControllerListener],
      environment: environment,
      command: ['webserver']
    },
    {
      name: "scheduler",
      image: schedulerImage.imageUri,
      memory: 128,
      environment: environment,
      command: ['scheduler']
    },
  ])
},)

const airflowController = new aws.ecs.Service('airflow-controller', {
  desiredCount: 1,
  cluster: cluster.arn,
  taskDefinition: serverSchedulerTaskDefinition.arn
})

const airflowerListener = new aws.lb.Listener("airflower-listener", {
  defaultActions: [{
    type: "forward",
  }],
  loadBalancerArn: airflowLoadBalancer.arn,
  port: 5555,
  protocol: "HTTP",
});
const airflowerImage = new awsx.ecr.Image("notflower", { repositoryUrl: repo.repositoryUrl, path: "./airflow-container" })

const flowerTaskDefinition = new aws.ecs.TaskDefinition('flower-task-definition', {
  family: 'my-special-family',
  containerDefinitions: JSON.stringify([
    // If the container is named "flower", we create environment variables that start
    // with `FLOWER_` and Flower tries and fails to parse them as configuration.
    {
      name: "notflower",
      image: airflowerImage.imageUri,
      memory: 128,
      portMappings: [airflowerListener],
      environment: environment,
      command: ['flower']
    }
  ])
})

const airflower = new aws.ecs.Service('airflow-controller', {
  cluster: cluster.arn,
  taskDefinition: flowerTaskDefinition.arn
})

const workerImage = new awsx.ecr.Image("worker", { repositoryUrl: repo.repositoryUrl, path: "./airflow-container" })

const workerTaskDefinition = new aws.ecs.TaskDefinition('worker-task-definition', {
  family: 'my-special-family',
  containerDefinitions: JSON.stringify([
    // If the container is named "flower", we create environment variables that start
    // with `FLOWER_` and Flower tries and fails to parse them as configuration.
    {
      name: "worker",
      image: workerImage.imageUri,
      memory: 1024,
      environment: environment,
      command: ['worker']
    }
  ])
})

const airflowWorkers = new aws.ecs.Service("airflow-workers", {
  cluster: cluster.arn,
  desiredCount: 3,
  taskDefinition: workerTaskDefinition.arn
});

export let airflowEndpoint = airflowControllerListener.urn
export let flowerEndpoint = airflowerListener.urn
