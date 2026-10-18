// Local browser QA of the actual resource and device frames. Transport data here
// is an explicitly synthetic test fixture; it is never shipped in the panel.
// Run with MINIMAP_PLAYWRIGHT_MODULE and MINIMAP_BROWSER_PATH if not installed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { panelResource } from '../runtime/mcp/resources.mjs';

const { chromium } = await import(process.env.MINIMAP_PLAYWRIGHT_MODULE ?? 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? '/tmp/minimap-panel-browser-qa');
fs.mkdirSync(out, { recursive: true });
const resource = panelResource({ uri: 'ui://frontend-test', view: 'device', webDir: path.join(root, 'runtime/core/web') });
assert.deepEqual(resource._meta.ui.csp, { connectDomains: [], resourceDomains: [], frameDomains: ['blob:'] });
assert.ok(!resource.text.includes("from './screen-graph.mjs'"), 'Resource must inline renderer module');
assert.ok(!resource.text.includes('href="/static/'), 'Resource must inline renderer CSS');

const bootstrap = `
globalThis.fixtureCalls = []; globalThis.fixtureContextListeners = []; globalThis.fixtureWorkspace = new URLSearchParams(location.search).has('workspace');
const fixtureSettings = {minimapEnabled:localStorage.getItem('fixtureMinimapEnabled')!=='false'};
let fixtureRevision = Number(localStorage.getItem('fixtureSettingsRevision')??0);
const fixtureGraph = {schema_version:'minimap.screen-graph.v1',places:[{id:'home',label:'Home',slug:'home'},{id:'detail',label:'Detail',slug:'detail'},{id:'settings',label:'Settings',slug:'settings'}],edges:[{id:'open',from:'home',to:'detail',steps:1,requiresHistory:false},{id:'settings',from:'home',to:'settings',steps:2,requiresHistory:false},{id:'back',from:'detail',to:'home',steps:1,requiresHistory:true}]};
const fixtureMap = {initialized:true,projectName:'Synthetic browser QA',packageName:'example.fixture',places:fixtureGraph.places,edges:fixtureGraph.edges,currentPlace:'home'};
const fixtureDevice = id => ({id,label:'Test device '+id,serial:'fixture-'+id,state:'ready',kind:'emulator'});
const fixtureInventory = {structuredContent:{devices:['a','b'].map(fixtureDevice),connectedDevices:[],avds:[],settings:fixtureSettings,settingsRevision:fixtureRevision},_meta:{panels:Object.fromEntries(['a','b'].map(id=>[id,{channel:{thread:id,key:'fixture-key'}}])),panel:{workspace:true,channel:{thread:'workspace',key:'fixture-key'}}}};
const fixtureQueues = new Map(), fixtureStarted = new Set();
const fixtureQueue = thread => {if(!fixtureQueues.has(thread))fixtureQueues.set(thread,[]);return fixtureQueues.get(thread);};
const fixtureStatus = thread => thread==='workspace'?{t:'workspace',...fixtureInventory}:{t:'status',emulator:{state:'ready',kind:'emulator',avd:'Test device',serial:'fixture'},capabilities:{},avds:[],createdByThisThread:[],profiles:[],images:[],settings:{...fixtureSettings},settingsRevision:fixtureRevision};
globalThis.fixtureNavigationEvent = () => {for(const thread of fixtureStarted)fixtureQueue(thread).push({j:{t:'navigation',busy:false}});};
globalThis.fixtureStaleStatus = () => fixtureQueue('single').push({j:{...fixtureStatus('single'),settings:{minimapEnabled:true},settingsRevision:fixtureRevision-1}});
globalThis.emulatorHost = {embedded:true,label:'Browser QA host',
 initialize:async()=>({capabilities:{},context:{theme:'light'}}),onContextChange:callback=>fixtureContextListeners.push(callback),onTeardown(){},onVisibilityChange(){},
 firstToolResult:async()=>fixtureWorkspace?fixtureInventory:{_meta:{panel:{channel:{thread:'single',key:'fixture-key'}}}},
 callTool:async(tool,args)=>{
   fixtureCalls.push({tool,args});
   if(tool==='emulator_devices')return fixtureInventory;
   if(tool!=='emulator_stream')return {};
   const queue=fixtureQueue(args.thread);
   for(const message of args.send??[]){
     if(message.t==='call'){
       let result={};
       if(message.tool==='emulator_devices')result=fixtureInventory;
       if(message.tool==='settings_update'){
         fixtureSettings.minimapEnabled=message.args.set.minimapEnabled;
         fixtureRevision++;
         localStorage.setItem('fixtureMinimapEnabled',String(fixtureSettings.minimapEnabled));
         localStorage.setItem('fixtureSettingsRevision',String(fixtureRevision));
         fixtureInventory.structuredContent.settingsRevision=fixtureRevision;
         for(const thread of fixtureStarted)fixtureQueue(thread).push({j:fixtureStatus(thread)});
         result={structuredContent:{values:{...fixtureSettings},revision:fixtureRevision}};
       }
       if(message.tool==='settings_read')result={structuredContent:{values:{...fixtureSettings},revision:fixtureRevision}};
       if(message.tool==='emulator_navigate')result=message.args.action==='graph'?{structuredContent:{graph:fixtureGraph,graphStatus:{status:'ok',message:'Saved graph (synthetic test fixture).'}}}:{structuredContent:{map:fixtureMap}};
       queue.push({j:{t:'result',id:message.id,ok:true,result}});
     }
   }
   if(!args.wait)return {structuredContent:{messages:[]}};
   await new Promise(resolve=>setTimeout(resolve,20));
   if(!fixtureStarted.has(args.thread)){
     fixtureStarted.add(args.thread);
     queue.unshift({j:fixtureStatus(args.thread)});
   }
   return {structuredContent:{messages:queue.splice(0)}};
 }
};
globalThis.fixtureTheme = context => fixtureContextListeners.forEach(listener=>listener(context));
`;
const html = resource.text.replace('<script type="module">', `<script>${bootstrap}</script><script type="module">`);
const server = http.createServer((request, response) => {
  if (request.url === '/favicon.ico') { response.writeHead(204).end(); return; }
  if (request.url === '/' || request.url === '/?workspace=1') { response.writeHead(200, { 'content-type': 'text/html' }).end(html); return; }
  response.writeHead(404).end('Unexpected resource request');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ ...(process.env.MINIMAP_BROWSER_PATH ? { executablePath: process.env.MINIMAP_BROWSER_PATH } : {}), headless: true });
const report = { transport: 'synthetic test fixture', checks: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 }, colorScheme: 'dark' });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  const url = `http://127.0.0.1:${server.address().port}/`;
  await page.goto(url); await page.locator('#minimap-toggle').waitFor();
  await page.waitForFunction(() => !document.getElementById('minimap-toggle').disabled);
  await page.locator('#minimap-toggle').click();
  await page.locator('#minimap-graph .graph-node').first().waitFor();
  assert.equal(await page.locator('[data-route-id]').count(), 3);
  assert.equal(await page.locator('[data-edge-count]').evaluateAll(cells => cells.reduce((n, cell) => n + Number(cell.dataset.edgeCount), 0)), 3);
  const before = await page.locator('.node-box').evaluateAll(nodes => nodes.map(node => node.outerHTML));
  const style = await page.locator('.graph-scroller svg').evaluate(svg => ({ width: svg.getBoundingClientRect().width, height: svg.getBoundingClientRect().height, fill: getComputedStyle(svg.querySelector('.node-box')).fill, textStroke: getComputedStyle(svg.querySelector('.node-name')).stroke }));
  assert.ok(style.width >= 1128 && style.height > 16);
  assert.notEqual(style.fill, 'none'); assert.equal(style.textStroke, 'none');
  await page.locator('[data-place-id="detail"]').click();
  assert.equal(await page.locator('#minimap-current').textContent(), 'Home');
  assert.equal(await page.evaluate(() => fixtureCalls.flatMap(call => call.args.send ?? []).filter(message => message.args?.action === 'go').length), 0);
  await page.locator('[data-place-id="home"]').focus(); await page.keyboard.press('Enter');
  assert.match(await page.locator('#minimap-graph-selected').textContent(), /Home/);
  await page.locator('[data-screen-index] summary').click();
  await page.locator('[data-select-screen="detail"]').focus(); await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.selectScreen), 'detail');
  await page.locator('#minimap-graph-go').click();
  await page.waitForFunction(() => fixtureCalls.some(call => call.args.send?.some(message => message.args?.action === 'go' && message.args.target === 'detail')));
  await page.waitForFunction(() => !document.getElementById('minimap-graph').hidden);
  report.checks.push('complete matrix/list; SVG icon CSS isolation; mouse/keyboard inspect-only; explicit Go');
  const stable = await page.locator('.node-box').evaluateAll(nodes => nodes.map(node => node.outerHTML));
  await page.evaluate(() => fixtureTheme({ theme: 'dark', styles: { variables: { '--color-background-primary': '#141820', '--color-background-secondary': '#1c2230', '--color-text-primary': '#f5f8fc', '--accent': '#83b9ff', '--font-sans': 'Arial' } } }));
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await page.locator('.graph-scroller svg').evaluate(svg => getComputedStyle(svg).getPropertyValue('--graph-paper').trim()), '#141820');
  assert.equal(await page.locator('.node-name').first().evaluate(node => getComputedStyle(node).fontFamily), 'Arial');
  assert.equal(await page.locator('.selected-node .node-box').evaluate(node => getComputedStyle(node).stroke), 'rgb(131, 185, 255)');
  assert.deepEqual(await page.locator('.node-box').evaluateAll(nodes => nodes.map(node => node.outerHTML)), stable);
  await page.locator('#minimap-graph').screenshot({ path: path.join(out, 'fixture-graph-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.evaluate(() => fixtureTheme({ theme: 'light', styles: { variables: { '--color-background-primary': '', '--color-background-secondary': '', '--color-text-primary': '', '--accent': '', '--font-sans': '' } } }));
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  report.checks.push('live host colors/fonts and explicit theme override browser; geometry/selection preserved');
  await page.locator('#minimap-graph-tab').focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#minimap-navigation-tab').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Home'); assert.equal(await page.locator('#minimap-graph-tab').getAttribute('aria-selected'), 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await page.evaluate(() => ({ viewport: innerWidth, body: document.documentElement.scrollWidth, graph: document.querySelector('.graph-scroller').scrollWidth, local: document.querySelector('.graph-scroller').clientWidth }));
  assert.ok(narrow.body <= narrow.viewport && narrow.graph > narrow.local);
  report.narrow = narrow; report.checks.push('tab keyboard semantics; narrow graph local scrolling');
  await page.setViewportSize({ width: 1680, height: 1100 });
  await page.locator('#more').click();
  await page.locator('#minimap-enabled').uncheck();
  await page.waitForFunction(() => !document.getElementById('minimap-enabled').disabled);
  assert.match(await page.locator('#minimap-setting-status').textContent(), /Off/);
  await page.locator('#drawer').screenshot({ path: path.join(out, 'minimap-tracking-toggle-off.png') });
  const callsOff = await page.evaluate(() => fixtureCalls.flatMap(call => call.args.send ?? []).filter(message => message.tool === 'emulator_navigate').length);
  await page.locator('#minimap-toggle').click();
  assert.equal(await page.locator('#minimap-disabled').isVisible(), true);
  assert.equal(await page.locator('#minimap-refresh').isDisabled(), true);
  assert.equal(await page.locator('#minimap-locate').isDisabled(), true);
  assert.equal(await page.locator('#minimap-graph-go').isDisabled(), true);
  assert.equal(await page.locator('#minimap-graph .graph-node').count(), 0);
  await page.evaluate(() => fixtureNavigationEvent());
  await page.evaluate(() => fixtureStaleStatus());
  await page.waitForFunction(() => fixtureQueues.get('single').length === 0);
  assert.equal(await page.locator('#minimap-enabled').isChecked(), false, 'a delayed pre-disable status cannot roll back the saved setting');
  assert.equal(await page.evaluate(() => fixtureCalls.flatMap(call => call.args.send ?? []).filter(message => message.tool === 'emulator_navigate').length), callsOff);
  await page.locator('#minimap-drawer').screenshot({ path: path.join(out, 'minimap-tracking-off.png') });
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('minimap-toggle').disabled);
  await page.locator('#minimap-toggle').click();
  assert.equal(await page.locator('#minimap-disabled').isVisible(), true);
  assert.equal(await page.evaluate(() => fixtureCalls.flatMap(call => call.args.send ?? []).filter(message => message.tool === 'emulator_navigate').length), 0);
  assert.equal(await page.locator('#more').isEnabled(), true, 'normal device controls remain enabled');
  await page.locator('#minimap-enable').click();
  await page.locator('#minimap-graph .graph-node').first().waitFor();
  report.checks.push('persistent toggle in Device controls; off map, navigation events and delayed stale statuses send zero Minimap calls; saved graph returns on enable');
  await page.goto(url + '?workspace=1');
  await page.waitForFunction(() => document.querySelectorAll('.device-frame').length === 1);
  await page.locator('#workspace-compare').click();
  await page.waitForFunction(() => document.querySelectorAll('.device-frame').length === 2);
  const a = page.frameLocator('#device-frame-0'), b = page.frameLocator('#device-frame-1');
  for (const frame of [a, b]) {
    await frame.locator('#minimap-toggle').waitFor();
    await frame.locator('#minimap-toggle').click();
    await frame.locator('[data-place-id="home"]').waitFor();
  }
  await a.locator('[data-place-id="detail"]').click();
  assert.match(await a.locator('#minimap-graph-selected').textContent(), /Detail/);
  assert.match(await b.locator('#minimap-graph-selected').textContent(), /Home/);
  await page.evaluate(() => fixtureTheme({ theme: 'dark' }));
  assert.equal(await a.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await b.locator('html').getAttribute('data-theme'), 'dark');
  await a.locator('#minimap-graph-go').click();
  await page.waitForFunction(() => fixtureCalls.some(call => call.args.thread === 'a' && call.args.send?.some(message => message.args?.action === 'go' && message.args.target === 'detail')));
  assert.equal(await page.evaluate(() => fixtureCalls.filter(call => call.args.thread === 'b').flatMap(call => call.args.send ?? []).filter(message => message.args?.action === 'go').length), 0);
  report.checks.push('two actual blob child frames; fixed device channels and independent selections; forwarded host context');
  await a.locator('#more').click();
  await a.locator('#minimap-enabled').uncheck();
  await b.locator('#minimap-disabled').waitFor();
  assert.equal(await b.locator('#minimap-enabled').isChecked(), false);
  assert.equal(await b.locator('#minimap-graph .graph-node').count(), 0);
  await b.locator('#minimap-enable').click();
  await b.locator('#minimap-graph .graph-node').first().waitFor();
  assert.equal(await a.locator('#minimap-enabled').isChecked(), true);
  report.checks.push('global settings status updates both device frames and clears other-frame graphs immediately');
  assert.deepEqual(errors, []); assert.ok(requests.every(request => request.startsWith(url) || request.startsWith('blob:')));
  report.pageErrors = errors; report.externalRequests = []; report.svg = style; report.passed = true;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
