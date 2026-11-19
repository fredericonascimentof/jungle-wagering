import {connectDatabase} from '../../src/database/orm';
import {createProcessorApp} from '../../src/processor/http';
import {SqsBroker} from '../../src/processor/sqs';
const orm=await connectDatabase(process.env.TEST_DATABASE_URL);const broker=new SqsBroker();
const app=await createProcessorApp(orm,broker);await app.listen(0,'127.0.0.1');
console.log(`READY:${await app.getUrl()}`);
async function close(){await app.close();broker.close();await orm.close(true);process.exit(0);}
process.on('SIGTERM',()=>{void close();});process.on('SIGINT',()=>{void close();});
