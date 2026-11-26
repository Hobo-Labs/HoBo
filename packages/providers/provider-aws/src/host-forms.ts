import { parseRegisteredHostForm, type RegisteredHostForm } from "@hobo/core";

export const AWS_HOST_FORMS: readonly RegisteredHostForm[] = Object.freeze(
	[
		{
			productId: "aws.ec2-instance/v1",
			providerService: "Amazon EC2 instance",
			form: "vm",
			formSources: [
				{
					url: "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/concepts.html",
					checkedAt: "2026-11-10",
					note: "'An EC2 instance is a virtual server in the AWS Cloud'",
				},
			],
			volumeProductId: "aws.ebs-volume/v1",
			facets: [
				{
					facet: "persistent-volume",
					holds: true,
					detail: "an Amazon EBS block-storage volume attached to the instance",
					sources: [
						{
							url: "https://docs.aws.amazon.com/ebs/latest/userguide/what-is-ebs.html",
							checkedAt: "2026-11-10",
							note: "'Amazon EBS volumes — These are storage volumes that you attach to Amazon EC2 instances'; EBS 'provides scalable, high-performance block storage resources'",
						},
					],
				},
			],
		},
		{
			productId: "aws.ecs-service/v1",
			resourceClass: "aws:fargate-service",
			providerService: "Amazon ECS service on Fargate",
			form: "container",
			formSources: [
				{
					url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs_services.html",
					checkedAt: "2026-11-10",
					note: "an ECS service keeps a desired number of tasks running",
				},
			],
			facets: [
				{
					facet: "long-running-compute",
					holds: true,
					detail: "an ECS service maintains its desired number of tasks",
					sources: [
						{
							url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs_services.html",
							checkedAt: "2026-11-10",
							note: "'This helps maintain your desired number of tasks in the service'",
						},
					],
				},
				{
					facet: "persistent-volume",
					holds: true,
					detail:
						"Amazon EFS file system mounted into the task (a network file system, not block storage)",
					sources: [
						{
							url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/efs-volumes.html",
							checkedAt: "2026-11-10",
							note: "'your tasks have access to the same persistent storage'; on Fargate, EFS is supported on platform version 1.4.0 or later",
						},
					],
				},
				{
					facet: "inbound-tcp",
					holds: true,
					detail: "TCP listener through a Network Load Balancer to the task",
					sources: [
						{
							url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/nlb.html",
							checkedAt: "2026-11-10",
							note: "the Network Load Balancer 'attempts to open a TCP connection to the selected target on the port specified in the listener configuration'",
						},
					],
				},
				{
					facet: "operator-control",
					holds: true,
					detail: "ECS Exec runs commands in the running container",
					sources: [
						{
							url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-exec.html",
							checkedAt: "2026-11-10",
							note: "'You can use ECS Exec to run commands in or get a shell to a container running on an Amazon EC2 instance or on AWS Fargate'",
						},
					],
				},
			],
		},
		{
			productId: "aws.app-runner/v1",
			providerService: "AWS App Runner",
			form: "container",
			formSources: [
				{
					url: "https://docs.aws.amazon.com/apprunner/latest/dg/develop.html",
					checkedAt: "2026-11-10",
					note: "App Runner runs container instances behind web requests",
				},
			],
			facets: [
				{
					facet: "inbound-tcp",
					holds: false,
					detail: "HTTP only: no raw TCP listener",
					sources: [
						{
							url: "https://docs.aws.amazon.com/apprunner/latest/dg/develop.html",
							checkedAt: "2026-11-10",
							note: "'App Runner provides support for HTTP 1.0 and HTTP 1.1 to the container instances'",
						},
					],
				},
			],
		},
	].map((form, index) =>
		parseRegisteredHostForm(form, `AWS_HOST_FORMS[${index}]`),
	),
);
