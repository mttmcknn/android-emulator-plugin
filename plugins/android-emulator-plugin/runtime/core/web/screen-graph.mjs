// Small dependency-free renderer. Geometry and theme are separate: the host
// supplies CSS variables; this module never observes a device or navigates it.
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function normalizeGraph(input) {
  const graph = input.graph ?? input;
  if (!Array.isArray(graph.places) || !Array.isArray(graph.edges)) throw new Error('Expected places and edges');
  const places = graph.places.map(place => {
    if (typeof place.id !== 'string' || typeof place.label !== 'string') throw new Error('Invalid place');
    return {...place, slug: place.slug ?? place.id};
  });
  const ids = new Set(places.map(place => place.id));
  if (ids.size !== places.length) throw new Error('Duplicate place ID');
  const edgeIDs = new Set();
  const edges = graph.edges.map(edge => {
    if (typeof edge.id !== 'string' || typeof edge.from !== 'string' || typeof edge.to !== 'string' || edgeIDs.has(edge.id)) throw new Error('Invalid or duplicate edge ID');
    edgeIDs.add(edge.id);
    return {...edge, dangling: !ids.has(edge.from) || !ids.has(edge.to)};
  });
  return {places, edges};
}

export function graphView(input, selectedID, detail = false) {
  const graph = normalizeGraph(input);
  const selected = graph.places.find(place => place.id === selectedID) ?? graph.places[0];
  if (!selected) return {...graph, selected: null, visiblePlaces: [], visibleEdges: [], hiddenPlaces: 0, hiddenEdges: graph.edges.length};
  const incident = graph.edges.filter(edge => !edge.dangling && (edge.from === selected.id || (detail && edge.to === selected.id)));
  const neighborIDs = new Set(incident.flatMap(edge => [edge.from, edge.to]));
  const others = graph.places.filter(place => place.id !== selected.id);
  // Keep the diagram readable; the complete matrix/list below retains every
  // place/edge. No missing endpoint is represented as an invented screen.
  const neighbors=others.filter(place=>neighborIDs.has(place.id));
  const candidates = detail ? neighbors : [...neighbors,...others.filter(place=>!neighborIDs.has(place.id))];
  const visiblePlaces = [selected, ...candidates.slice(0, 8)];
  const visibleIDs = new Set(visiblePlaces.map(place => place.id));
  const visibleEdges = incident.filter(edge => visibleIDs.has(edge.from) && visibleIDs.has(edge.to)).slice(0, 12);
  return {...graph, selected, visiblePlaces, visibleEdges, hiddenPlaces: candidates.length - (visiblePlaces.length - 1), hiddenEdges: graph.edges.length - visibleEdges.length};
}

export function layoutGraph(view) {
  const others = view.visiblePlaces.filter(place => place.id !== view.selected?.id);
  const boxes = new Map();
  let nextY=88;
  others.forEach(place=>{
    const ports=view.visibleEdges.filter(edge=>edge.from===place.id||edge.to===place.id).length;
    const h=Math.max(112,72+Math.max(0,ports-1)*36);
    boxes.set(place.id,{x:768,y:nextY,w:288,h});nextY+=h+32;
  });
  const selectedHeight=Math.max(112,40+(view.visibleEdges.length+1)*12);
  const loopCount=view.visibleEdges.filter(edge=>edge.from===edge.to).length;
  const baseHeight = Math.max(460,nextY+88,selectedHeight+208);
  const selectedY=Math.max(88+loopCount*32,Math.round((baseHeight-80-selectedHeight)/2/4)*4);
  const height=Math.max(baseHeight,selectedY+selectedHeight+88);
  const selectedX=Math.max(72,48+Math.max(0,loopCount-1)*12);
  if (view.selected) boxes.set(view.selected.id, {x:selectedX,y:selectedY,w:288,h:selectedHeight});
  const peerPorts = new Map();
  let loopIndex=0;
  let connectionIndex=0;
  const routes = view.visibleEdges.map((edge,index) => {
    const from = boxes.get(edge.from), to = boxes.get(edge.to);
    if (edge.from === edge.to) {
      const x = from.x, y = from.y;
      const loop=loopIndex++,top=y-32-loop*32;
      return {edge, points:[[x,y+36+loop*12],[x-40-loop*12,y+36+loop*12],[x-40-loop*12,top],[x+64+loop*12,top],[x+64+loop*12,y]], label:{x:x+88,y:top-28}, selfLoop:true};
    }
    const outgoing = edge.from === view.selected.id;
    const peer = outgoing ? to : from;
    const peerID = outgoing ? edge.to : edge.from;
    const portIndex = peerPorts.get(peerID) ?? 0;
    peerPorts.set(peerID,portIndex+1);
    const peerY = peer.y+44+portIndex*36;
    const selected = boxes.get(view.selected.id);
    const connection=connectionIndex++;
    const selectedY = selected.y+20+(connection+1)*12;
    const channel = selected.x+selected.w+56+connection*16;
    const points = [[selected.x+selected.w,selectedY],[channel,selectedY],[channel,peerY],[peer.x,peerY]];
    if (!outgoing) points.reverse();
    return {edge,points,label:{x:604,y:peerY-28},selfLoop:false};
  });
  return {width:1128,height,boxes,routes};
}

// Only axis-aligned segments, with short quadratic corner fillets.
export function roundedPath(points, radius=8) {
  if (!points.length) return '';
  let d=`M${points[0][0]} ${points[0][1]}`;
  for(let i=1;i<points.length-1;i++){
    const previous=points[i-1],corner=points[i],next=points[i+1];
    const before=Math.hypot(corner[0]-previous[0],corner[1]-previous[1]);
    const after=Math.hypot(next[0]-corner[0],next[1]-corner[1]);
    const r=Math.min(radius,before/2,after/2);
    if (!before || !after) continue;
    const start=[corner[0]+(previous[0]-corner[0])*r/before,corner[1]+(previous[1]-corner[1])*r/before];
    const end=[corner[0]+(next[0]-corner[0])*r/after,corner[1]+(next[1]-corner[1])*r/after];
    d+=`L${start[0]} ${start[1]}Q${corner[0]} ${corner[1]} ${end[0]} ${end[1]}`;
  }
  const last=points.at(-1);return d+`L${last[0]} ${last[1]}`;
}

function shortLabel(value,limit=24){return value.length>limit?value.slice(0,limit-1)+'…':value;}
function routeLabel(edge, sourceDerived){
  if(sourceDerived){
    if(edge.kind==='tab')return 'SWITCH TAB';
    if(edge.kind==='top-level-reset')return 'DRAWER RESET';
    if(edge.kind==='back')return edge.label?.startsWith('Drawer')?'DRAWER RETURN':'BACK';
    if(edge.label?.startsWith('Drawer'))return 'DRAWER PROFILE';
    if(edge.label==='Select message author')return 'SELECT AUTHOR';
    return shortLabel((edge.label??edge.kind??'NAVIGATE').toUpperCase(),14);
  }
  return edge.requiresHistory?'BACK · HISTORY':`${edge.steps} ${edge.steps===1?'STEP':'STEPS'}`;
}

function crossingMasks(route,earlier){
  const masks=[];
  for(let i=1;i<route.points.length;i++){
    const a=route.points[i-1],b=route.points[i];
    for(const previous of earlier)for(let j=1;j<previous.points.length;j++){
      const c=previous.points[j-1],d=previous.points[j];
      const horizontal=a[1]===b[1],otherHorizontal=c[1]===d[1];
      if(horizontal===otherHorizontal)continue;
      const x=horizontal?c[0]:a[0],y=horizontal?a[1]:c[1];
      const within=(v,p,q)=>v>Math.min(p,q)+8&&v<Math.max(p,q)-8;
      if(horizontal?within(x,a[0],b[0])&&within(y,c[1],d[1]):within(y,a[1],b[1])&&within(x,c[0],d[0]))masks.push(`<rect class="edge-crossing-gap" x="${x-4}" y="${y-4}" width="8" height="8"/>`);
    }
  }
  return masks.join('');
}

export function renderSVG(view,{namespace='screen-graph',sourceDerived=false}={}) {
  const layout=layoutGraph(view),prefix=escapeHTML(namespace);
  if(!view.selected)return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1128 460" role="img" aria-labelledby="${prefix}-title ${prefix}-desc"><title id="${prefix}-title">Empty graph</title><desc id="${prefix}-desc">No saved screens or current device state are represented.</desc><text x="72" y="120">No saved screens</text></svg>`;
  const connectors=layout.routes.map((route,index)=>{const {edge,points,label}=route;return `<g class="graph-edge${edge.requiresHistory?' history-edge':''}" data-edge-id="${escapeHTML(edge.id)}"><title>${escapeHTML(edge.label ?? edge.id)}</title>${crossingMasks(route,layout.routes.slice(0,index))}<path d="${roundedPath(points)}" marker-end="url(#${prefix}-arrow)"/><rect class="edge-label-mask" x="${label.x}" y="${label.y}" width="156" height="20"/><text class="edge-label" x="${label.x+8}" y="${label.y+14}">${escapeHTML(routeLabel(edge,sourceDerived))}</text></g>`;}).join('');
  const nodes=view.visiblePlaces.map(place=>{
    const box=layout.boxes.get(place.id),selected=place.id===view.selected.id;
    return `<g class="graph-node${selected?' selected-node':''}" data-place-id="${escapeHTML(place.id)}" role="button" tabindex="0" aria-label="Select ${escapeHTML(place.label)}" aria-pressed="${selected}"><title>${escapeHTML(place.label+' · '+place.slug)}</title><rect class="node-mask" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="8"/><rect class="node-box" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="8"/><text class="node-tag" x="${box.x+20}" y="${box.y+28}">${selected?'SELECTED SCREEN':sourceDerived?'SOURCE SCREEN':'SAVED SCREEN'}</text><text class="node-name" x="${box.x+20}" y="${box.y+60}">${escapeHTML(shortLabel(place.label,27))}</text><text class="node-detail" x="${box.x+20}" y="${box.y+86}">${view.edges.filter(edge=>edge.from===place.id).length} outgoing routes</text></g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-labelledby="${prefix}-title ${prefix}-desc"><title id="${prefix}-title">${sourceDerived?'Source-derived':'Recorded'} screen graph</title><desc id="${prefix}-desc">${view.places.length} screens and ${view.edges.length} directed connections. This diagram shows ${view.visibleEdges.length} connections for the selected screen; the complete topology is below. No current device location or screen images are represented.</desc><defs><marker id="${prefix}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 1L9 5L0 9" fill="none" stroke="var(--graph-muted)" stroke-width="1.5"/></marker></defs><rect width="${layout.width}" height="${layout.height}" fill="var(--graph-paper)"/><text class="section-label" x="72" y="44">${sourceDerived?'SOURCE NAVIGATION':'RECORDED NAVIGATION'} · SELECTED CONNECTIONS</text>${connectors}${nodes}<line class="legend-rule" x1="40" y1="${layout.height-56}" x2="1088" y2="${layout.height-56}"/><g class="legend"><line x1="40" y1="${layout.height-28}" x2="80" y2="${layout.height-28}" marker-end="url(#${prefix}-arrow)"/><text x="96" y="${layout.height-24}">Directed connection</text><rect class="legend-selection" x="312" y="${layout.height-36}" width="16" height="16" rx="2"/><text x="340" y="${layout.height-24}">Selected screen</text><text x="600" y="${layout.height-24}">Every connection is listed below</text></g></svg>`;
}

export function renderMatrix(graph,selectedID) {
  const names=new Map(graph.places.map(place=>[place.id,place.label]));
  if(graph.places.length>20)return '<p>Matrix omitted above 20 screens; the complete directed-route list follows.</p>';
  return `<table class="route-matrix"><caption>Complete directed topology · rows are origins, columns are destinations</caption><thead><tr><th scope="col">From ↓ / To →</th>${graph.places.map(place=>`<th scope="col">${escapeHTML(place.label)}</th>`).join('')}</tr></thead><tbody>${graph.places.map(from=>`<tr${from.id===selectedID?' class="selected-row"':''}><th scope="row">${escapeHTML(from.label)}</th>${graph.places.map(to=>{const edges=graph.edges.filter(edge=>edge.from===from.id&&edge.to===to.id);return `<td data-from="${escapeHTML(from.id)}" data-to="${escapeHTML(to.id)}" data-edge-count="${edges.length}"${edges.length?' class="connected"':''} title="${escapeHTML(edges.map(edge=>edge.label??edge.id).join('; ') || 'No connection')}" aria-label="${escapeHTML(names.get(from.id)+' to '+names.get(to.id)+': '+edges.length+' connections')}">${edges.length||'—'}</td>`;}).join('')}</tr>`).join('')}</tbody></table>`;
}

export function renderScreenIndex(graph,selectedID){
  return `<details data-screen-index><summary>All screens (${graph.places.length})</summary><div class="graph-screen-index">${graph.places.map(place=>`<button class="graph-button" data-select-screen="${escapeHTML(place.id)}" aria-pressed="${place.id===selectedID}">${escapeHTML(place.label)} <span>${escapeHTML(place.slug)}</span></button>`).join('')}</div></details>`;
}

let instance=0;
export function mountScreenGraph(container,input,{selectedID,detail=false,onSelect=()=>{}}={}) {
  const sourceDerived=input.schema==='minimap.source-screen-graph.v1';
  const graph=normalizeGraph(input),namespace=`minimap-graph-${++instance}`;
  let selected=graph.places.some(place=>place.id===selectedID)?selectedID:graph.places[0]?.id,focus=detail;
  const names=new Map(graph.places.map(place=>[place.id,place.label]));
  const render=()=>{
    const indexWasOpen=container.querySelector('[data-screen-index]')?.open??false;
    const view=graphView(graph,selected,focus);
    const incident=graph.edges.filter(edge=>edge.from===selected||(focus&&edge.to===selected));
    container.innerHTML=`<div class="graph-workbench"><section class="graph-column"><div class="graph-toolbar"><span>${graph.places.length} screens · ${graph.edges.length} ${sourceDerived?'source connections':'saved routes'}</span><span>${view.visibleEdges.length} connections drawn · ${focus?'incoming + outgoing':'outgoing'}</span></div><div class="graph-scroller">${renderSVG(view,{namespace,sourceDerived})}</div></section><aside class="graph-inspector"><div class="graph-eyebrow">SCREEN DETAILS</div><h2>${escapeHTML(view.selected?.label??'Empty graph')}</h2><p class="graph-slug">${escapeHTML(view.selected?.slug??'')}</p><button class="graph-button" data-focus aria-pressed="${focus}">${focus?'Show all screens':'Focus incoming + outgoing'}</button><section><h3>${focus?'Incident connections':'Outgoing connections'}</h3>${incident.map(edge=>`<div class="route-row"><strong>${escapeHTML(names.get(edge.from)??edge.from)} → ${escapeHTML(names.get(edge.to)??edge.to)}</strong><span>${escapeHTML(sourceDerived?(edge.label??edge.kind):routeLabel(edge,false))}</span>${edge.dangling?'<span>Missing endpoint · retained in route list</span>':''}</div>`).join('')||'<p>No outgoing connections.</p>'}</section><section><p>${sourceDerived?'Source topology is not a device observation or replayable recipe.':'Recorded routes are saved knowledge; the current device state is unknown.'}</p><p>No per-screen screenshots are stored.</p></section></aside></div><section class="complete-topology"><h2>Full graph</h2><p>All ${graph.places.length} screens and ${graph.edges.length} connections remain available here. The diagram above follows selection to keep routes readable.</p><div class="matrix-scroller">${renderMatrix(graph,selected)}</div>${renderScreenIndex(graph,selected)}<details><summary>All directed connections (${graph.edges.length})</summary><ol>${graph.edges.map(edge=>`<li data-route-id="${escapeHTML(edge.id)}"><strong>${escapeHTML(names.get(edge.from)??edge.from)} → ${escapeHTML(names.get(edge.to)??edge.to)}</strong> · ${escapeHTML(sourceDerived?(edge.label??edge.kind):routeLabel(edge,false))}${edge.dangling?' · missing endpoint':''}</li>`).join('')}</ol></details></section>`;
    container.querySelector('[data-screen-index]').open=indexWasOpen;
    for(const node of container.querySelectorAll('[data-place-id],[data-select-screen]')){
      const choose=()=>{selected=node.dataset.placeId??node.dataset.selectScreen;render();onSelect(selected);};
      node.addEventListener('click',choose);
      node.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();const id=node.dataset.placeId??node.dataset.selectScreen;const fromIndex=Boolean(node.dataset.selectScreen);choose();for(const replacement of container.querySelectorAll(fromIndex?'[data-select-screen]':'[data-place-id]'))if((replacement.dataset.placeId??replacement.dataset.selectScreen)===id)replacement.focus();}});
    }
    container.querySelector('[data-focus]').addEventListener('click',()=>{focus=!focus;render();});
  };
  render();return {select(id){if(!names.has(id))throw new Error('Unknown screen');selected=id;render();},setDetail(value){focus=Boolean(value);render();},getSelection(){return selected;},destroy(){container.replaceChildren();}};
}
