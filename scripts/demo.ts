import {randomUUID} from 'node:crypto';
import {SendMessageCommand} from '@aws-sdk/client-sqs';
import {SqsBroker} from '../src/processor/sqs';
const base=process.env.API_URL??'http://127.0.0.1:3000';
const broker=new SqsBroker();
async function json(path:string,method='GET',body?:unknown,key?:string) {
  const res=await fetch(base+path,{method,headers:{'content-type':'application/json',...(key?{'Idempotency-Key':key}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!res.ok)throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json() as Promise<Record<string,unknown>>;
}
try {
  await broker.initialize();await json('/health/ready');
  const wallet=await json('/wallets','POST',{playerId:randomUUID(),initialBalance:{amount:'100.00',currency:'BRL'}});
  const external=randomUUID(),key=`provider-a:${external}`;
  const business={providerId:'provider-a',externalTransactionId:external,playerId:wallet.playerId,walletId:wallet.id,
    roundId:'demo-round',gameId:'demo-game',kind:'BET',money:{amount:'80.00',currency:'BRL'}};
  await broker.client.send(new SendMessageCommand({QueueUrl:broker.inputUrl,MessageGroupId:String(wallet.id),MessageDeduplicationId:randomUUID(),
    MessageBody:JSON.stringify({messageId:randomUUID(),type:'WagerTransactionRequested',occurredAt:new Date().toISOString(),data:{...business,idempotencyKey:key}})}));
  let processed=false;
  for(let attempt=0;attempt<100;attempt++) {
    const res=await fetch(`${base}/providers/provider-a/wagering/transactions/${external}`);
    if(res.ok) {const result=await res.json() as {status:string};if(result.status==='PROCESSED'){processed=true;break;}}
    await Bun.sleep(100);
  }
  if(!processed)throw new Error('Worker não confirmou aposta em 10 segundos.');
  const replay=await json('/wagering/transactions','POST',business,key);
  const reconciliation=await json(`/wallets/${wallet.id}/reconciliation`,'POST');
  const result={api:base,walletId:wallet.id,externalTransactionId:external,replay,reconciliation};
  await Bun.write('demo-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  if(replay.idempotentReplay!==true||reconciliation.consistent!==true)throw new Error('Demo invariant failed');
} finally {broker.close();}
