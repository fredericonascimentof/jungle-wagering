import {EntitySchema} from '@mikro-orm/core';
export class FinancialWalletRow {
  id!:string;playerId!:string;currency!:string;balance!:string;version!:number;createdAt!:Date;updatedAt!:Date;
}
export const FinancialWalletSchema=new EntitySchema<FinancialWalletRow>({class:FinancialWalletRow,tableName:'financial_wallets',properties:{
  id:{type:'uuid',primary:true},playerId:{type:'uuid',fieldName:'player_id'},currency:{type:'string',length:3},
  balance:{type:'string',columnType:'numeric(18,2)'},version:{type:'integer'},
  createdAt:{type:'Date',fieldName:'created_at'},updatedAt:{type:'Date',fieldName:'updated_at'},
}});
