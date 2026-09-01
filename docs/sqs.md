# SQS

QueueはStandard。Message bodyは次だけにする。

```json
{"statementId":"019abc00-0000-7000-8000-000000000001"}
```

WorkerはReceiveMessageのWaitTimeSecondsを長くしてLong Pollingする。Messageを処理中はVisibility Timeoutで一時的に見えなくなるだけで、DeleteMessageまで消えない。Standard Queueはat-least-once deliveryなのでduplicate deliveryを前提にする。

retryableなBedrock throttling、network、temporary AWS errorはMessageをdeleteせず、visibility期限後の再配送へ任せる。unsupported image、permanent schema failureはFAILEDを保存してackし、main queueのmaxReceiveCount超過はDLQへ送る。

参照: [SQS visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)。

