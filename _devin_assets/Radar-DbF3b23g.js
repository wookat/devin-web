import{n as e}from"./rolldown-runtime-C0FnF6B9.js";import{t}from"./react-B3wg_K76.js";function n(e={}){let{frames:t=50,speed:n=.0017,size:r=300,inset:i=3,parent:a=document.body}=e,o=document.createTextNode(`
    .lagRadar-sweep > * {
      shape-rendering: crispEdges;
    }
    .lagRadar-face {
      fill: transparent;
    }
    .lagRadar-hand {
      stroke-width: 4px;
      stroke-linecap: round;
    }
  `);function s(e,t={},n=[]){let r=document.createElementNS(`http://www.w3.org/2000/svg`,e);return Object.keys(t).forEach(e=>r.setAttribute(e,t[e])),n.forEach(e=>r.appendChild(e)),r}let c=Math.PI*2,l=r/2,u=l-i,d=s(`path`,{class:`lagRadar-hand`}),f=Array(t).fill(`path`).map(e=>s(e)),p=s(`svg`,{class:`lagRadar`,height:r,width:r},[s(`style`,{type:`text/css`},[o]),s(`g`,{class:`lagRadar-sweep`},f),d,s(`circle`,{class:`lagRadar-face`,cx:l,cy:l,r:u})]);a.appendChild(p);let m,h=0,g={rotation:0,now:Date.now(),tx:l+u,ty:l},_=(()=>{let e=120/Math.log(100);return function(t){return 120-Math.max(0,Math.min(e*Math.log(t/10),120))}})();function v(){let e=Date.now(),r=Math.min(c-n,n*(e-g.now)),i=(g.rotation+r)%c,a=l+u*Math.cos(i),o=l+u*Math.sin(i),s=`M${a} ${o}A${u} ${u} 0 ${r<Math.PI?`0`:`1`} 0 ${g.tx} ${g.ty}L${l} ${l}`,p=_(r/n);f[h%t].setAttribute(`d`,s),f[h%t].setAttribute(`fill`,`hsl(${p}, 80%, 40%)`),d.setAttribute(`d`,`M${l} ${l}L${a} ${o}`),d.setAttribute(`stroke`,`hsl(${p}, 80%, 60%)`);for(let e=0;e<t;e++)f[(t+h-e)%t].style.fillOpacity=1-e/t;h++,g={now:e,rotation:i,tx:a,ty:o},m=window.requestAnimationFrame(v)}return v(),function(){m&&window.cancelAnimationFrame(m),p.remove()}}var r,i;function a(){return(a=e((()=>{r=t(),i=(0,r.memo)(function(e){let t=e.frames||20,i=e.size||100,a=Object.assign({},e,{frames:t,size:i}),o=(0,r.useRef)();return(0,r.useLayoutEffect)(()=>n(Object.assign({},a,{parent:o.current})),[a,o]),(0,r.createElement)(`div`,{ref:o})})})))()}a();export{i as default};