import { SQSClient, CreateQueueCommand, GetQueueAttributesCommand, SendMessageCommand, ReceiveMessageCommand,
  DeleteMessageCommand, ChangeMessageVisibilityCommand, type Message } from '@aws-sdk/client-sqs';
import { createHash } from 'node:crypto';
export class SqsBroker {
  readonly client: SQSClient;
  inputUrl=''; dlqUrl=''; eventsUrl='';
  constructor(readonly prefix=process.env.SQS_QUEUE_PREFIX??'') {
    this.client=new SQSClient({region:process.env.AWS_REGION??'us-east-1',endpoint:process.env.SQS_ENDPOINT??'http://127.0.0.1:4566',
      credentials:{accessKeyId:process.env.AWS_ACCESS_KEY_ID??'test',secretAccessKey:process.env.AWS_SECRET_ACCESS_KEY??'test'},maxAttempts:2});
  }
  async initialize() {
    const dlq=await this.client.send(new CreateQueueCommand({QueueName:`${this.prefix}wager-transactions-dlq.fifo`,Attributes:{FifoQueue:'true',ContentBasedDeduplication:'false'}}),{abortSignal:AbortSignal.timeout(5000)});
    this.dlqUrl=dlq.QueueUrl!;
    const attributes=await this.client.send(new GetQueueAttributesCommand({QueueUrl:this.dlqUrl,AttributeNames:['QueueArn']}));
    const input=await this.client.send(new CreateQueueCommand({QueueName:`${this.prefix}wager-transactions.fifo`,Attributes:{FifoQueue:'true',
      ContentBasedDeduplication:'false',VisibilityTimeout:'30',RedrivePolicy:JSON.stringify({deadLetterTargetArn:attributes.Attributes?.QueueArn,maxReceiveCount:'5'})}}));
    this.inputUrl=input.QueueUrl!;
    const events=await this.client.send(new CreateQueueCommand({QueueName:`${this.prefix}wager-events.fifo`,Attributes:{FifoQueue:'true',ContentBasedDeduplication:'false'}}));
    this.eventsUrl=events.QueueUrl!;
  }
  async ready() {
    if(!this.inputUrl) await this.initialize();
    await this.client.send(new GetQueueAttributesCommand({QueueUrl:this.inputUrl,AttributeNames:['QueueArn']}),{abortSignal:AbortSignal.timeout(3000)});
  }
  async receive():Promise<Message[]> {
    if(!this.inputUrl) await this.initialize();
    const response=await this.client.send(new ReceiveMessageCommand({QueueUrl:this.inputUrl,MaxNumberOfMessages:1,WaitTimeSeconds:1,
      VisibilityTimeout:30,MessageSystemAttributeNames:['ApproximateReceiveCount']}),{abortSignal:AbortSignal.timeout(5000)});
    return response.Messages??[];
  }
  async ack(receipt:string) { await this.client.send(new DeleteMessageCommand({QueueUrl:this.inputUrl,ReceiptHandle:receipt})); }
  async visibility(receipt:string,seconds:number) { await this.client.send(new ChangeMessageVisibilityCommand({QueueUrl:this.inputUrl,ReceiptHandle:receipt,VisibilityTimeout:seconds})); }
  async deadLetter(message:Message) {
    const id=message.MessageId??createHash('sha256').update(message.Body??'').digest('hex');
    await this.client.send(new SendMessageCommand({QueueUrl:this.dlqUrl,MessageBody:message.Body??'{}',
      MessageGroupId:'invalid',MessageDeduplicationId:id}),{abortSignal:AbortSignal.timeout(5000)});
    if(message.ReceiptHandle) await this.ack(message.ReceiptHandle);
  }
  async publish(id:string,aggregateId:string,payload:unknown) {
    if(!this.eventsUrl) await this.initialize();
    await this.client.send(new SendMessageCommand({QueueUrl:this.eventsUrl,MessageBody:JSON.stringify(payload),
      MessageGroupId:aggregateId,MessageDeduplicationId:id}),{abortSignal:AbortSignal.timeout(5000)});
  }
  close() { this.client.destroy(); }
}
