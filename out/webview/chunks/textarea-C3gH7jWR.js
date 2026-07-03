import{r as s,j as v}from"./bridge-DaGGd3P5.js";import{c as k}from"./button-CzEAYDpy.js";/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const x=(...t)=>t.filter((e,r,o)=>!!e&&e.trim()!==""&&o.indexOf(e)===r).join(" ").trim();/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const A=t=>t.replace(/([a-z0-9])([A-Z])/g,"$1-$2").toLowerCase();/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const L=t=>t.replace(/^([A-Z])|[\s-_]+(\w)/g,(e,r,o)=>o?o.toUpperCase():r.toLowerCase());/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const u=t=>{const e=L(t);return e.charAt(0).toUpperCase()+e.slice(1)};/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */var c={xmlns:"http://www.w3.org/2000/svg",width:24,height:24,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"};/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const W=t=>{for(const e in t)if(e.startsWith("aria-")||e==="role"||e==="title")return!0;return!1},y=s.createContext({}),j=()=>s.useContext(y),E=s.forwardRef(({color:t,size:e,strokeWidth:r,absoluteStrokeWidth:o,className:n="",children:a,iconNode:p,...l},m)=>{const{size:i=24,strokeWidth:d=2,absoluteStrokeWidth:f=!1,color:h="currentColor",className:C=""}=j()??{},b=o??f?Number(r??d)*24/Number(e??i):r??d;return s.createElement("svg",{ref:m,...c,width:e??i??c.width,height:e??i??c.height,stroke:t??h,strokeWidth:b,className:x("lucide",C,n),...!a&&!W(l)&&{"aria-hidden":"true"},...l},[...p.map(([g,w])=>s.createElement(g,w)),...Array.isArray(a)?a:[a]])});/**
 * @license lucide-react v1.17.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const N=(t,e)=>{const r=s.forwardRef(({className:o,...n},a)=>s.createElement(E,{ref:a,iconNode:e,className:x(`lucide-${A(u(t))}`,`lucide-${t}`,o),...n}));return r.displayName=u(t),r};function R({className:t,...e}){return v.jsx("textarea",{"data-slot":"textarea",className:k("flex field-sizing-content min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20",t),...e})}export{R as T,N as c};
