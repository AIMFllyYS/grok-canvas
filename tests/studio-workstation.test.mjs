import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {loadTypescript} from './helpers/load-typescript.mjs';
const conversations = await loadTypescript('lib/studio/conversations.ts');
const prompt = await loadTypescript('lib/prompt-nodes.ts');
const schema = await loadTypescript('lib/studio/schema.ts',{packages:true});
const catalog = await loadTypescript('lib/studio/model-catalog.ts',{packages:true});
const usage = await loadTypescript('lib/xai/usage.ts');
const batch = await loadTypescript('lib/studio/batch.ts',{packages:true});
const canvasEdit = await loadTypescript('lib/studio/canvas-edit.ts');
const placement = await loadTypescript('lib/node-placement.ts');
after(async()=>{for(const item of [conversations,prompt,schema,catalog,usage,batch,canvasEdit,placement])await item.dispose();});
test('legacy transcripts migrate without losing history; new chats and their model settings stay isolated',()=>{
 const messages=[{id:'u1',role:'user',parts:[{type:'text',text:'Original conversation'}]}];
 const project={id:'p',createdAt:'now',updatedAt:'now',messages:structuredClone(messages)};
 const original=conversations.module.ensureConversations(project);
 assert.deepEqual(original.messages,messages);
 original.settings={model:'grok-4.7',fast:true};
 const fresh=conversations.module.newConversation(project);
 assert.notEqual(fresh.id,original.id);assert.deepEqual(project.messages,[]);
 assert.deepEqual(fresh.settings,original.settings);assert.notEqual(fresh.settings,original.settings);
 conversations.module.saveConversation(project,original.id,[...messages,{id:'a1',role:'assistant',parts:[{type:'text',text:'done'}]}]);
 assert.equal(project.messages.length,0);assert.equal(original.messages.length,2);
 assert.throws(()=>conversations.module.saveConversation(project,'missing',[]),/不存在/);
});
test('prompt parameter links resolve in order and never consume image attachment slots',()=>{
 const nodes=[{id:'p1',type:'prompt',data:{text:'Paper texture'}},{id:'p2',type:'text',data:{text:'Soft light'}},{id:'image',type:'image',data:{}}];
 const edges=[{source:'p1',target:'image',data:{promptInput:true}},{source:'p2',target:'image',data:{promptInput:true}},{source:'image',target:'p1'}];
 assert.equal(prompt.module.resolveNodePrompt('image','A small boat',nodes,edges),'Paper texture\n\nSoft light\n\nA small boat');
});
test('approval only authorizes the exact script version, and batch stops before producing unapproved assets',async()=>{
 const p={script:'complete',scriptVersion:2,scriptApproval:{version:1},references:[{id:'R1'}],shots:[]};
 assert.equal(schema.module.isScriptApproved(p),false);
 let calls=0;const progress=[];
 for await(const step of batch.module.runProductionBatch('p','all',undefined,{load:async()=>p,produce:async()=>{calls++;}}))progress.push(step);
 assert.equal(calls,0);assert.equal(progress.at(-1).stage,'approval');assert.equal(progress.at(-1).finished,true);
 p.scriptApproval.version=2;assert.equal(schema.module.isScriptApproved(p),true);
});
test('CLI catalog exposes only declared fast variants and context/effort options',()=>{
 const models=catalog.module.parseModelCatalog([{id:'grok-4.7',name:'Grok 4.7',context_windows:[256000,500000],reasoning_efforts:[{value:'high'}],api_backend:'responses'},{id:'grok-4.7-build-fast',name:'Grok 4.7 Fast'},{id:'grok-4.6',name:'Grok 4.6'},{id:'hidden',hidden:true}]);
 assert.equal(models.length,2);assert.equal(models[0].fastId,'grok-4.7-build-fast');assert.equal(models[1].fastId,undefined);assert.deepEqual(models[0].contextWindows,[256000,500000]);
});
test('unified billing shows credits without fabricating a percentage; manual refresh bypasses cache',async()=>{
 const value=usage.module.parseUsage({config:{isUnifiedBillingUser:true,prepaidBalance:{val:1000},onDemandUsed:{val:0},onDemandCap:{val:0}}});
 assert.equal(value.usedPercent,null);assert.equal(value.balanceCredits,1000);
 let calls=0;
 const read=usage.module.createUsageReader({identity:async()=>'a',request:async()=>{calls++;return new Response(JSON.stringify({config:{creditUsagePercent:calls}}));}});
 await read();await read();assert.equal(calls,1);await read(true);assert.equal(calls,2);
});
test('canvas tool changes validate atomically and preserve director-managed nodes',()=>{
 const canvas={nodes:[{id:'note',type:'text',position:{x:0,y:0},data:{text:'soft light'}},{id:'image',type:'image',position:{x:300,y:0},data:{uploadAttachments:[]}},{id:'managed',type:'workflow',position:{x:0,y:300},data:{studioProjectId:'project'}}],edges:[]};
 const empty={updates:[],remove:[],connect:[],disconnect:[]};
 const changed=canvasEdit.module.editCanvasDocument(canvas,{...empty,updates:[{id:'note',text:'paper texture'}],connect:[{source:'note',target:'image'}]});
 assert.equal(canvas.nodes[0].data.text,'soft light');assert.equal(changed.nodes[0].data.text,'paper texture');assert.equal(changed.edges[0].data.promptInput,true);
 assert.throws(()=>canvasEdit.module.editCanvasDocument(canvas,{...empty,updates:[{id:'note',text:'changed'}],remove:['managed']}),/导演台/);
 assert.equal(canvas.nodes[0].data.text,'soft light');
 assert.throws(()=>canvasEdit.module.editCanvasDocument(canvas,{...empty,connect:[{source:'note',target:'missing'}]}),/端点/);
});
test('new text or media nodes use a free position instead of stacking at the viewport center',()=>{
 const origin={x:100,y:100};assert.deepEqual(placement.module.placeNewNode(origin,[]),origin);
 const point=placement.module.placeNewNode(origin,[{position:origin,measured:{width:280,height:240}}]);
 assert.ok(point.x>=404||point.x+304<=100||point.y>=364||point.y+264<=100);
});
