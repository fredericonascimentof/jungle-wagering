import {connectDatabase} from '../../src/database/orm';
import {ProcessorService} from '../../src/processor/service';
import {SqsBroker} from '../../src/processor/sqs';
import {Consumer,Publisher} from '../../src/processor/workers';
const orm=await connectDatabase(process.env.TEST_DATABASE_URL);const broker=new SqsBroker();await broker.initialize();
const service=new ProcessorService(orm);const mode=process.argv[2];
if(mode==='publisher-crash') {
  await new Publisher(service,broker,async()=>{process.exit(87);}).tick();
} else {
  let message;
  for(let i=0;i<15&&!message;i++) message=(await broker.receive())[0];
  if(!message)throw new Error('No test message');
  await new Consumer(service,broker,mode==='consumer-crash'?async()=>{
    console.log(`RECEIPT:${message!.ReceiptHandle}`);process.exit(86);
  }:undefined).handle(message);
}
broker.close();await orm.close(true);
