import {describe,it,expect} from 'vitest';
import {expectedEditIntent} from './editIntentJournal';
import {ToolRegistry,tool} from './registry';
import {registerTaskPlan} from './taskPlan';
import {z} from 'zod';
describe('durable edit intent matching',()=>{
 it('extracts supported shape edit intent and refuses unsupported operations',()=>{
  expect(expectedEditIntent('app_command',{command:'shape.edit',params:{layer:20,rect:[300,490,100,100]}})?.rect).toEqual([300,490,100,100]);
  expect(expectedEditIntent('external_command',{command:'shape.edit',params:{layer:20,rect:[300,490,100,100]}})).toBeUndefined();
 });
 it('needs full geometry, target identity and an actual shape.info receipt',()=>{
  const reg=new ToolRegistry([tool('app_command','read',z.object({command:z.string()}),async()=> 'Result: {"layer":20,"live":{"rect":[300,490,100,100]}}')]);
  const control=registerTaskPlan(reg,'Move',undefined,()=>{});
  const receipt=control.record('app_command','Result: {"layer":20,"live":{"rect":[300,490,100,100]}}',false,{command:'shape.info'});
  expect(receipt).toBe('r1');
  expect(control.matchesRecordedRect('r1',20,[300,490,100,100])).toBe(true);
  expect(control.matchesRecordedRect('r1',22,[300,490,100,100])).toBe(false);
  expect(control.matchesRecordedRect('r1',20,[300,490,101,100])).toBe(false);
 });
});
