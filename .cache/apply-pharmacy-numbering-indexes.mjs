import mongoose from 'mongoose';
import fs from 'node:fs/promises';
mongoose.set('autoIndex',false); mongoose.set('autoCreate',false);
const {Invoice}=await import('../models/Invoice.ts');
const {PharmacyInvoicePrefix}=await import('../models/PharmacyInvoiceNumbering.ts');
const plans=[{model:Invoice,old:'invoiceNumber_1',oldKey:{invoiceNumber:1},replacement:'invoice_organization_number_v1',key:{organizationId:1,invoiceNumber:1}},{model:PharmacyInvoicePrefix,old:'prefix_1',oldKey:{prefix:1},replacement:'pharmacy_organization_prefix_v1',key:{organizationId:1,prefix:1}}];
try {
 await mongoose.connect(process.env.MONGODB_URI,{autoIndex:false,autoCreate:false,serverSelectionTimeoutMS:15000});
 const hello=await mongoose.connection.db.admin().command({hello:1});
 if(!hello.setName&&hello.msg!=='isdbgrid') throw new Error('Transaction-capable database required.');
 const review=[];
 for(const plan of plans){const indexes=await plan.model.collection.listIndexes().toArray();const existing=indexes.find(x=>x.name===plan.old), replacement=indexes.find(x=>x.name===plan.replacement);if(!replacement?.unique||JSON.stringify(replacement.key)!==JSON.stringify(plan.key)||replacement.partialFilterExpression||replacement.sparse) throw new Error('Expected scoped unique index is not ready.');if(existing&&(!existing.unique||JSON.stringify(existing.key)!==JSON.stringify(plan.oldKey)||existing.partialFilterExpression||existing.sparse)) throw new Error('Old index does not match the reviewed definition.');review.push({collection:plan.model.collection.name,remove:existing??null,retain:replacement});}
 await fs.writeFile('.cache/pharmacy-numbering-index-review.json',JSON.stringify({writesPaused:true,review},null,2));
 let removed=0;
 for(let i=0;i<plans.length;i++){if(review[i].remove){await plans[i].model.collection.dropIndex(plans[i].old);removed++;}}
 console.log(JSON.stringify({removed,retainedScopedUniqueIndexes:2,invoicesRewritten:0,stockWrites:0}));
} catch(error){console.error('Reviewed numbering index setup failed; no record contents or connection details are logged.');process.exitCode=1;} finally {await mongoose.disconnect();}
