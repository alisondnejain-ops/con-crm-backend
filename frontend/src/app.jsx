const { useState, useEffect, useMemo, useRef } = React;

/* ===== IDENTIDADE ===== */
const C = {
  ink:"#14181F", sub:"#5A6472", faint:"#8A93A0", line:"#E6E9E7", surface:"#F4F6F5", card:"#FFFFFF",
  green:"#0E8F6E", greenDeep:"#0A3D30", greenMid:"#0C6B52", greenSoft:"#E5F2EC",
  hot:"#E1553A", hotSoft:"#FBE7E1", amber:"#C8912B", amberSoft:"#F7EFD9", cool:"#5C6B7A", coolSoft:"#ECEFF2", white:"#FFF",
};
const DISPLAY="'Sora',sans-serif", FONT="'Inter',sans-serif", MONO="'IBM Plex Mono',monospace";
const ADM_CODE="CONECTA-JAZ-2026";
const PRIO={QUENTE:{c:C.hot,bg:C.hotSoft,label:"Quente"},MORNO:{c:C.amber,bg:C.amberSoft,label:"Morno"},FRIO:{c:C.cool,bg:C.coolSoft,label:"Frio"}};
const STAGES=["Lead","Atendimento","Pasta","Aprovação","Agendamento","Visita","Proposta","Venda","Perdido","Recaptação","Transferido por ligação"];
const LINEAR=["Lead","Atendimento","Pasta","Aprovação","Agendamento","Visita","Proposta","Venda"];
const STAGE_C={"Lead":"#64748B","Atendimento":"#0E8F6E","Pasta":"#0C6B52","Aprovação":"#2F80C4","Agendamento":"#7A5AD6","Visita":"#C8912B","Proposta":"#D97706","Venda":"#0A3D30","Perdido":"#B0463A","Recaptação":"#B07C1F","Transferido por ligação":"#5C6B7A"};

/* ===== avanço automático de etapa pela conversa ===== */
function inferStage(cur, msgs){
  const i = LINEAR.indexOf(cur);
  if(i<0) return cur; // etapas manuais (Venda/Perdido/Recaptação/Transferido) não mexem
  const text = msgs.filter(m=>m.from!=="system").map(m=>(m.text||"").toLowerCase()).join(" ");
  const leadReplies = msgs.filter(m=>m.from==="lead").length;
  const has=(arr)=>arr.some(k=>text.includes(k));
  let t=i;
  if(msgs.some(m=>m.from==="corretor")||leadReplies>=1) t=Math.max(t,LINEAR.indexOf("Atendimento"));
  if(has(["documento","documentação","documentacao","pasta","cadastro","comprovante","enviar rg"])) t=Math.max(t,LINEAR.indexOf("Pasta"));
  if(has(["aprov","crédito","credito","análise","analise","financiamento","banco","caixa","simulação","simulacao"])) t=Math.max(t,LINEAR.indexOf("Aprovação"));
  if(has(["agendar","agenda","marcar","horário","horario","que dia","sábado","sabado","disponibilidade","podemos marcar"])) t=Math.max(t,LINEAR.indexOf("Agendamento"));
  if(has(["confirmad","te espero","endereço","endereco","combinado","no local","pode vir"])) t=Math.max(t,LINEAR.indexOf("Visita"));
  if(has(["proposta","contrato","assinar","valor final","fechar negócio","fechar negocio"])) t=Math.max(t,LINEAR.indexOf("Proposta"));
  t=Math.min(t,LINEAR.indexOf("Proposta")); // automático nunca fecha como Venda
  return LINEAR[t];
}

/* ===== EQUIPE ===== */
const GESTOR={id:"g1",name:"Ali",ini:"AL",color:C.greenDeep,role:"adm",email:"ali@conecta.com"};
const SDR={id:"s1",name:"Camila Rocha",ini:"CR",color:"#B07C1F",role:"sdr",email:"camila@conecta.com"};
const SEED_BROKERS=[
  {id:"b1",name:"Marina Alves",ini:"MA",color:"#0E8F6E",role:"corretor",email:"marina@conecta.com"},
  {id:"b2",name:"Rafael Nunes",ini:"RN",color:"#3B7BC4",role:"corretor",email:"rafael@conecta.com"},
  {id:"b3",name:"Juliana Prado",ini:"JP",color:"#C8912B",role:"corretor",email:"juliana@conecta.com"},
  {id:"b4",name:"Diego Matos",ini:"DM",color:"#7A5AD6",role:"corretor",email:"diego@conecta.com"},
];
const SEED_AVAIL={s1:true,b1:true,b2:true,b3:false,b4:true};
const SEED_NAMES={g1:"Ali",s1:"Camila",b1:"Marina",b2:"Rafael",b3:"Juliana",b4:"Diego"};

/* ===== LEADS ===== */
const now=Date.now(), min=(m)=>m*60000, q=(a,b,c,d,e)=>({renda:a,entrada:b,situacao:c,cpf:d,prazo:e});
let LEAD_SEED=[
  {nome:"Antônio Marcos",tel:"+55 (87) 99212-8802",prio:"QUENTE",origem:"Instagram",createdAgo:min(9),assignedTo:"b1",status:"Proposta",firstRespMin:3,qual:q("Acima de R$ 5.000","Sim, acima de R$ 15 mil","Servidor público","Não, CPF regular","O mais rápido possível"),msgs:[["lead","Oi, vi o anúncio da casa no Jardim Amazonas",8],["corretor","Oi Antônio! Aqui é a Marina, da Conecta 👋 Posso te passar as condições?",7,"b1"],["lead","Pode sim! Qual o valor da entrada?",5]]},
  {nome:"Beatriz Carvalho",tel:"+55 (87) 99155-7596",prio:"QUENTE",origem:"Facebook",createdAgo:min(40),assignedTo:"b1",status:"Agendamento",firstRespMin:6,qual:q("Entre R$ 3.501 e R$ 5.000","Sim, entre R$ 5 mil e R$ 15 mil","CLT","Não, CPF regular","Nos próximos 3 meses"),msgs:[["corretor","Oi Beatriz! Podemos marcar uma visita no sábado?",38,"b1"],["lead","Adorei! Consigo visitar sábado sim",30]]},
  {nome:"Jackson Silva",tel:"+55 (74) 98112-1382",prio:"QUENTE",origem:"Instagram",createdAgo:min(70),assignedTo:"b2",status:"Venda",firstRespMin:4,qual:q("Acima de R$ 5.000","Sim, acima de R$ 15 mil","Autônomo","Não, CPF regular","O mais rápido possível"),msgs:[["corretor","Oi Jackson, aqui é o Rafael da Conecta!",68,"b2"],["lead","Fechado, quero seguir com a proposta",20]]},
  {nome:"Aline Souza",tel:"+55 (87) 98158-9003",prio:"QUENTE",origem:"Facebook",createdAgo:min(120),assignedTo:"b2",status:"Visita",firstRespMin:9,qual:q("Acima de R$ 5.000","Sim, entre R$ 5 mil e R$ 15 mil","Servidor público","CPF regularizado","Nos próximos 3 meses"),msgs:[["corretor","Oi Aline! Visita confirmada, te espero no local 🏡",110,"b2"]]},
  {nome:"Ednaldo Gomes",tel:"+55 (87) 99151-3193",prio:"MORNO",origem:"Instagram",createdAgo:min(30),assignedTo:"b3",status:"Atendimento",firstRespMin:12,qual:q("Entre R$ 2.001 e R$ 3.500","Sim, até R$ 5 mil","CLT","Não, CPF regular","Entre 3 e 6 meses"),msgs:[["corretor","Oi Ednaldo! Aqui é a Juliana da Conecta 🙂",28,"b3"],["lead","Oi! Ainda tô pesquisando",15]]},
  {nome:"Raquel Oliveira",tel:"+55 (87) 98866-4969",prio:"MORNO",origem:"Facebook",createdAgo:min(55),assignedTo:"b3",status:"Recaptação",firstRespMin:20,qual:q("Entre R$ 3.501 e R$ 5.000","Sim, até R$ 5 mil","Autônomo","Não, CPF regular","Entre 3 e 6 meses"),msgs:[["corretor","Oi Raquel! Consegue falar por aqui?",50,"b3"]]},
  {nome:"Lucas Henrique",tel:"+55 (87) 98834-3139",prio:"MORNO",origem:"Instagram",createdAgo:min(15),assignedTo:"b4",status:"Pasta",firstRespMin:8,qual:q("Entre R$ 2.001 e R$ 3.500","Não tenho entrada","CLT","Não, CPF regular","Nos próximos 3 meses"),msgs:[["corretor","Oi Lucas! Me envia sua documentação pra montar a pasta?",13,"b4"],["lead","Opa! Mando sim",10]]},
  {nome:"Silvanda Rodrigues",tel:"+55 (87) 99199-5225",prio:"MORNO",origem:"Facebook",createdAgo:min(200),assignedTo:"b4",status:"Perdido",firstRespMin:45,qual:q("Até R$ 2.000","Não tenho entrada","Desempregado","Tem restrição","Só pesquisando"),msgs:[["corretor","Oi Silvanda! Posso te ajudar?",190,"b4"]]},
  {nome:"Anderson Augusto",tel:"+55 (87) 99159-6170",prio:"MORNO",origem:"Instagram",createdAgo:min(22),assignedTo:"b1",status:"Aprovação",firstRespMin:5,qual:q("Entre R$ 3.501 e R$ 5.000","Sim, até R$ 5 mil","CLT","Não, CPF regular","Entre 3 e 6 meses"),msgs:[["corretor","Oi Anderson! Já mandei sua simulação de crédito pro banco 🏦",20,"b1"],["lead","Show! Qual a parcela?",12]]},
  {nome:"Marcos Vinícius",tel:"+55 (87) 98701-2244",prio:"MORNO",origem:"Instagram",createdAgo:min(90),assignedTo:"b2",status:"Transferido por ligação",firstRespMin:15,qual:q("Entre R$ 3.501 e R$ 5.000","Sim, até R$ 5 mil","Autônomo","Não, CPF regular","Nos próximos 3 meses"),msgs:[["corretor","Oi Marcos! Te liguei agora há pouco 📞",80,"b2"]]},
  {nome:"Patrícia Nunes",tel:"+55 (87) 99633-1050",prio:"QUENTE",origem:"Instagram",createdAgo:min(18),assignedTo:"s1",status:"Atendimento",firstRespMin:7,qual:q("Acima de R$ 5.000","Sim, entre R$ 5 mil e R$ 15 mil","CLT","Não, CPF regular","O mais rápido possível"),msgs:[["corretor","Oi Patrícia! Aqui é a Camila, da Conecta 👋",16,"s1"],["lead","Oi! Quero saber mais sobre a casa",12]]},
  // fila da SDR (não atribuídos)
  {nome:"Fernanda Camila",tel:"+55 (87) 99942-4151",prio:"QUENTE",origem:"Instagram",createdAgo:min(2),assignedTo:null,status:"Lead",firstRespMin:null,qual:q("Acima de R$ 5.000","Sim, acima de R$ 15 mil","Servidor público","Não, CPF regular","O mais rápido possível"),msgs:[]},
  {nome:"Wesley Roberto",tel:"+55 (87) 98834-2383",prio:"MORNO",origem:"Facebook",createdAgo:min(1),assignedTo:null,status:"Lead",firstRespMin:null,qual:q("Entre R$ 2.001 e R$ 3.500","Sim, até R$ 5 mil","Autônomo","Não, CPF regular","Nos próximos 3 meses"),msgs:[]},
  {nome:"Eveline Lima",tel:"+55 (74) 98825-4449",prio:"QUENTE",origem:"Instagram",createdAgo:min(4),assignedTo:null,status:"Lead",firstRespMin:null,qual:q("Acima de R$ 5.000","Sim, entre R$ 5 mil e R$ 15 mil","CLT","Não, CPF regular","O mais rápido possível"),msgs:[]},
].map((l,i)=>({id:"l"+(i+1),createdAt:now-l.createdAgo,firstRespAt:l.firstRespMin!=null?now-l.createdAgo+min(l.firstRespMin):null,...l,
  msgs:l.msgs.map(m=>({from:m[0],text:m[1],at:now-min(m[2]),by:m[3]||null}))}));

const TEMPLATES=[
  {t:"Primeiro contato (forte)",body:"Oi {nome}! Aqui é o time da Conecta Imóveis. Você se cadastrou pra realizar o sonho da casa própria no Jardim Amazonas e eu não quero que você perca as condições dessa fase. Posso te mostrar agora quanto ficaria a sua entrada e a parcela que cabe no seu bolso?"},
  {t:"Follow-up",body:"Oi {nome}, passando aqui rapidinho 🙂 As unidades dessa fase estão saindo. Quer que eu segure uma simulação no seu nome hoje?"},
  {t:"Agendar visita",body:"{nome}, que tal conhecer o imóvel de pertinho? Consigo te agendar essa semana. Prefere durante a semana ou no sábado?"},
  {t:"Pedir documentação",body:"{nome}, pra eu já adiantar a sua pasta e a simulação de crédito, consegue me enviar seus documentos (RG, CPF e comprovante de renda)?"},
];

/* ===== helpers ===== */
// Dois cortes de largura:
//  - até 760px  (celular): uma tela por vez + navegação inferior;
//  - até 1024px (tablet/janela estreita): lista + conversa lado a lado, e a ficha
//    passa a abrir por botão — senão a conversa fica espremida entre os dois painéis.
const MOBILE_BP=760, COMPACT_BP=1024;
function useMedia(query){
  const [m,setM]=useState(()=>typeof window!=="undefined"&&window.matchMedia(query).matches);
  useEffect(()=>{const mq=window.matchMedia(query);const h=(e)=>setM(e.matches);
    mq.addEventListener("change",h);setM(mq.matches);return()=>mq.removeEventListener("change",h);},[query]);
  return m;
}
const useIsMobile=()=>useMedia(`(max-width:${MOBILE_BP}px)`);
const useIsCompact=()=>useMedia(`(max-width:${COMPACT_BP}px)`);
const fmtAge=(ms)=>{const s=Math.max(0,Math.floor(ms/1000));if(s<60)return s+"s";const m=Math.floor(s/60);if(m<60)return m+" min";return Math.floor(m/60)+"h "+(m%60)+"min";};
const ageColor=(ms)=>{const m=ms/60000;return m<2?C.green:m<10?C.amber:C.hot;};
const fmtClock=(at)=>new Date(at).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});
const initials=(n)=>n.split(" ").map(x=>x[0]).slice(0,2).join("").toUpperCase();
const first=(n)=>n.split(" ")[0];

/* ===== ícones (SVG inline) ===== */
const ICO={
  send:<React.Fragment><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></React.Fragment>,
  search:<React.Fragment><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></React.Fragment>,
  phone:<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.11 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.7 2.34a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.74-1.74a2 2 0 0 1 2.11-.45c.74.34 1.53.57 2.34.7A2 2 0 0 1 22 16.92z"/>,
  clock:<React.Fragment><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></React.Fragment>,
  timer:<React.Fragment><line x1="10" y1="2" x2="14" y2="2"/><line x1="12" y1="14" x2="15" y2="11"/><circle cx="12" cy="14" r="8"/></React.Fragment>,
  flame:<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>,
  check:<React.Fragment><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></React.Fragment>,
  calendar:<React.Fragment><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></React.Fragment>,
  zap:<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>,
  star:<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>,
  chevron:<polyline points="9 18 15 12 9 6"/>,
  arrow:<React.Fragment><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></React.Fragment>,
  users:<React.Fragment><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></React.Fragment>,
  chart:<React.Fragment><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></React.Fragment>,
  trend:<React.Fragment><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></React.Fragment>,
  grid:<React.Fragment><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></React.Fragment>,
  phone2:<React.Fragment><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></React.Fragment>,
  wifi:<React.Fragment><path d="M5 12.55a11 11 0 0 1 14 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></React.Fragment>,
  wifioff:<React.Fragment><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.9 15.9 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></React.Fragment>,
  key:<React.Fragment><circle cx="7.5" cy="15.5" r="5.5"/><path d="M11.4 11.6 21 2"/><path d="m16 7 3 3"/></React.Fragment>,
  loader:<path d="M21 12a9 9 0 1 1-6.219-8.56"/>,
  columns:<React.Fragment><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/></React.Fragment>,
  mail:<React.Fragment><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22 6 12 13 2 6"/></React.Fragment>,
  target:<React.Fragment><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></React.Fragment>,
  award:<React.Fragment><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></React.Fragment>,
  spark:<path d="M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2L12 3z"/>,
  logout:<React.Fragment><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></React.Fragment>,
  lock:<React.Fragment><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></React.Fragment>,
  dot:<React.Fragment><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/></React.Fragment>,
  userplus:<React.Fragment><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></React.Fragment>,
  toggleOn:<React.Fragment><rect x="1" y="5" width="22" height="14" rx="7"/><circle cx="16" cy="12" r="3" fill="currentColor"/></React.Fragment>,
  toggleOff:<React.Fragment><rect x="1" y="5" width="22" height="14" rx="7"/><circle cx="8" cy="12" r="3" fill="currentColor"/></React.Fragment>,
  transfer:<React.Fragment><polyline points="17 3 21 7 17 11"/><line x1="21" y1="7" x2="9" y2="7"/><polyline points="7 21 3 17 7 13"/><line x1="3" y1="17" x2="15" y2="17"/></React.Fragment>,
  msg:<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>,
  pin:<React.Fragment><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></React.Fragment>,
  link:<React.Fragment><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></React.Fragment>,
};
function Icon({n,size=18,color,fill="none",spin}){
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={color||"currentColor"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={spin?"spin":""} style={{display:"block"}}>{ICO[n]}</svg>;
}

/* ===== átomos ===== */
function Avatar({ini,color,size=34}){return <div style={{width:size,height:size,background:color,color:"#fff",fontFamily:DISPLAY,fontWeight:600,fontSize:size*0.4,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{ini}</div>;}
function Pill({children,c,bg}){return <span style={{color:c,background:bg,fontSize:11,fontWeight:600,padding:"3px 8px",borderRadius:999,whiteSpace:"nowrap"}}>{children}</span>;}
function Metric({n,label,value,sub,accent=C.green}){
  return <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16,flex:1,minWidth:150}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
      <div style={{background:accent+"18",color:accent,width:32,height:32,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center"}}><Icon n={n} size={16}/></div>
      <span style={{color:C.sub,fontSize:12,fontWeight:500}}>{label}</span>
    </div>
    <div style={{color:C.ink,fontFamily:MONO,fontSize:26,fontWeight:600,lineHeight:1}}>{value}</div>
    {sub&&<div style={{color:C.faint,fontSize:11,marginTop:4}}>{sub}</div>}
  </div>;
}
function Brand({size=44}){
  return <div style={{display:"flex",alignItems:"center",gap:10}}>
    <div style={{background:C.green,width:size,height:size,borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff"}}><Icon n="dot" size={size*0.5}/></div>
    <div style={{fontFamily:DISPLAY,lineHeight:1}}>
      <div style={{color:C.ink,fontSize:20,fontWeight:700}}>Con<span style={{color:C.green}}>CRM</span></div>
      <div style={{color:C.faint,fontSize:10,fontWeight:500,letterSpacing:.5}}>CONECTA IMÓVEIS</div>
    </div>
  </div>;
}

/* ===== LOGIN / CADASTRO ===== */
function Auth({brokers,onLogin,onSignup}){
  const [tab,setTab]=useState("entrar");
  const [f,setF]=useState({name:"",email:"",pass:"",code:""});
  const [err,setErr]=useState("");
  const isMobile=useIsMobile();
  const set=(k)=>(e)=>setF({...f,[k]:e.target.value});
  function signup(){
    if(!f.name||!f.email||!f.pass)return setErr("Preencha nome, e-mail e senha.");
    if(f.code.trim().toUpperCase()!==ADM_CODE)return setErr("Código da imobiliária inválido. Peça o código à ADM da Conecta.");
    setErr("");onSignup(f);
  }
  const accBtn=(u,tag)=><button key={u.id} onClick={()=>onLogin(u)} style={{width:"100%",display:"flex",alignItems:"center",gap:12,border:`1px solid ${C.line}`,borderRadius:12,padding:10,marginBottom:8,background:C.card,cursor:"pointer"}}>
    <Avatar ini={u.ini} color={u.color} size={36}/><div style={{textAlign:"left",flex:1}}><div style={{color:C.ink,fontSize:13.5,fontWeight:600}}>{u.name}</div><div style={{color:C.faint,fontSize:11}}>{u.email}</div></div>{tag}</button>;
  return <div style={{fontFamily:FONT,background:C.surface,width:"100%",minHeight:"100dvh",display:"flex",alignItems:isMobile?"stretch":"center",justifyContent:"center",padding:isMobile?0:24}}>
    <div style={{width:"100%",maxWidth:isMobile?"none":860,display:"grid",gridTemplateColumns:"1fr 1fr",borderRadius:isMobile?0:24,overflow:"hidden",boxShadow:isMobile?"none":"0 20px 60px rgba(0,0,0,.12)",border:isMobile?"none":`1px solid ${C.line}`}} className="authgrid">
      <div style={{background:C.greenDeep,padding:isMobile?"24px 22px":32,color:"#fff",display:"flex",flexDirection:"column",justifyContent:"space-between",gap:isMobile?16:0,minHeight:isMobile?0:460}}>
        <Brand size={isMobile?38:44}/>
        <div><div style={{fontFamily:DISPLAY,fontSize:isMobile?21:26,fontWeight:700,lineHeight:1.15,marginBottom:isMobile?8:12}}>Cada lead na mão certa, no tempo certo.</div>
          {!isMobile&&<p style={{color:"rgba(255,255,255,.75)",fontSize:13,lineHeight:1.6}}>Todos atendem pelo número da Conecta, cada mensagem assinada com o nome do corretor. A SDR distribui na catraca, e o funil avança sozinho conforme a conversa evolui.</p>}</div>
        {!isMobile&&<div style={{color:"rgba(255,255,255,.5)",fontSize:11}}>Prévia · dados de exemplo</div>}
      </div>
      <div style={{background:C.card,padding:isMobile?"24px 22px 40px":32}}>
        <div style={{display:"flex",background:C.surface,borderRadius:12,padding:4,marginBottom:24}}>
          {[["entrar","Entrar"],["cadastrar","Criar conta"]].map(([k,l])=>(
            <button key={k} onClick={()=>{setTab(k);setErr("");}} style={{flex:1,fontSize:13,fontWeight:600,padding:"8px",borderRadius:8,border:"none",cursor:"pointer",background:tab===k?C.card:"transparent",color:tab===k?C.ink:C.faint,boxShadow:tab===k?"0 1px 3px rgba(0,0,0,.08)":"none"}}>{l}</button>
          ))}
        </div>
        {tab==="entrar"?<div>
          <div style={{color:C.sub,fontSize:12,marginBottom:12}}>Selecione uma conta (demonstração):</div>
          {accBtn(GESTOR,<Pill c={C.greenMid} bg={C.greenSoft}>ADM</Pill>)}
          {accBtn(SDR,<Pill c={"#B07C1F"} bg={C.amberSoft}>SDR</Pill>)}
          {brokers.map(b=>accBtn(b,<Icon n="chevron" size={16} color={C.faint}/>))}
        </div>:<div style={{display:"flex",flexDirection:"column",gap:12}}>
          <Field n="users" placeholder="Nome completo" value={f.name} onChange={set("name")}/>
          <Field n="mail" placeholder="E-mail" value={f.email} onChange={set("email")}/>
          <Field n="lock" placeholder="Senha" type="password" value={f.pass} onChange={set("pass")}/>
          <div><Field n="key" placeholder="Código da imobiliária (ADM)" value={f.code} onChange={set("code")}/>
            <div style={{color:C.faint,fontSize:11,marginTop:4,marginLeft:4}}>Vincula sua conta à ADM da Conecta. Demo: <b style={{color:C.greenMid}}>{ADM_CODE}</b></div></div>
          {err&&<div style={{color:C.hot,background:C.hotSoft,fontSize:12,borderRadius:8,padding:"8px 12px"}}>{err}</div>}
          <button onClick={signup} style={{background:C.green,color:"#fff",fontSize:14,fontWeight:600,padding:"10px",borderRadius:12,border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>Criar conta e vincular <Icon n="arrow" size={16}/></button>
        </div>}
      </div>
    </div>
  </div>;
}
function Field({n,...p}){return <div style={{display:"flex",alignItems:"center",gap:8,border:`1px solid ${C.line}`,background:C.surface,borderRadius:12,padding:"0 12px"}}><Icon n={n} size={16} color={C.faint}/><input {...p} style={{flex:1,fontSize:13.5,padding:"10px 0",outline:"none",border:"none",background:"transparent",color:C.ink,width:"100%"}}/></div>;}

/* ===== APP ===== */
function ConCRM(){
  const [brokers,setBrokers]=useState(SEED_BROKERS);
  const [avail,setAvail]=useState(SEED_AVAIL);
  const [conecta,setConecta]=useState({connected:true,number:"+55 (87) 3021-9000"});
  const [leads,setLeads]=useState(LEAD_SEED);
  const [session,setSession]=useState(null);
  function signup(f){
    const id="b"+Date.now().toString().slice(-4);
    const cols=["#0E8F6E","#3B7BC4","#C8912B","#7A5AD6","#B0463A","#0C6B52"];
    const nb={id,name:f.name,ini:initials(f.name),color:cols[brokers.length%cols.length],role:"corretor",email:f.email};
    setBrokers(p=>[...p,nb]);setAvail(p=>({...p,[id]:false}));setSession(nb);
  }
  if(!session)return <Auth brokers={brokers} onLogin={setSession} onSignup={signup}/>;
  return <Workspace {...{session,setSession,brokers,avail,setAvail,conecta,setConecta,leads,setLeads}}/>;
}

function Workspace({session,setSession,brokers,avail,setAvail,conecta,setConecta,leads,setLeads}){
  const role=session.role;
  const canAttend=role==="corretor"||role==="sdr";
  const attendants=[...brokers,SDR]; // a SDR também atende
  const [view,setView]=useState(role==="adm"?"dashboard":role==="sdr"?"catraca":"atendimento");
  const [selId,setSelId]=useState(null);
  const [tick,setTick]=useState(0);
  const [draft,setDraft]=useState("");
  const [repBroker,setRepBroker]=useState(brokers[0].id);
  const [ptr,setPtr]=useState(0);
  const [handoffPtr,setHandoffPtr]=useState(0);
  const chatRef=useRef(null);
  const isMobile=useIsMobile();

  useEffect(()=>{const t=setInterval(()=>setTick(x=>x+1),1000);return()=>clearInterval(t);},[]);
  useEffect(()=>{if(chatRef.current)chatRef.current.scrollTop=chatRef.current.scrollHeight;},[selId,leads]);
  // No desktop já abrimos o primeiro lead; no celular o corretor começa vendo a lista.
  useEffect(()=>{if(canAttend&&!selId&&!isMobile){const fst=leads.find(l=>l.assignedTo===session.id);if(fst)setSelId(fst.id);}},[]);

  const myLeads=useMemo(()=>leads.filter(l=>l.assignedTo===session.id).sort((a,b)=>{const o={QUENTE:0,MORNO:1,FRIO:2};return o[a.prio]-o[b.prio]||b.createdAt-a.createdAt;}),[leads,session,tick]);
  const sel=leads.find(l=>l.id===selId);

  function applyMsg(leadId, entry, simulateReply){
    setLeads(prev=>prev.map(l=>{
      if(l.id!==leadId)return l;
      const msgs=[...l.msgs,entry];
      let status=l.status, firstRespAt=l.firstRespAt;
      if(entry.from==="corretor"&&firstRespAt==null&&!l.msgs.some(m=>m.from==="corretor"))firstRespAt=Date.now();
      const inf=inferStage(status,msgs);
      if(inf!==status){msgs.push({from:"system",text:"Etapa atualizada automaticamente para "+inf,at:Date.now()});status=inf;}
      return {...l,msgs,status,firstRespAt};
    }));
    if(simulateReply){
      setTimeout(()=>applyMsg(leadId,{from:"lead",text:"Que ótimo! Tenho interesse 😊 me explica como funciona a entrada e o agendamento da visita?",at:Date.now()},false),1600);
    }
  }
  function send(){
    if(!draft.trim()||!sel)return;
    const text=draft.replace("{nome}",first(sel.nome));
    const replies=sel.msgs.filter(m=>m.from==="lead").length;
    applyMsg(sel.id,{from:"corretor",text,at:Date.now(),by:session.id,byName:first(session.name)}, replies<2);
    setDraft("");
  }
  const setStatus=(id,status)=>setLeads(prev=>prev.map(l=>l.id===id?{...l,status}:l));
  const openLead=(id)=>{setSelId(id);setView("atendimento");};
  const toggleAvail=(id)=>setAvail(p=>({...p,[id]:!p[id]}));
  const transfer=(leadId,bId)=>setLeads(prev=>prev.map(l=>l.id===leadId?{...l,assignedTo:bId}:l));
  function catracaNext(leadId){
    const avl=attendants.filter(b=>avail[b.id]);
    if(!avl.length)return;
    const b=avl[ptr%avl.length];setPtr(ptr+1);transfer(leadId,b.id);
  }
  // SDR faz o 1º atendimento e repassa: o lead vai para o corretor da vez e sai do inbox dela.
  const availCorretores=brokers.filter(b=>avail[b.id]); // brokers = apenas corretores
  function handoffNext(leadId){
    if(!availCorretores.length)return;
    const b=availCorretores[handoffPtr%availCorretores.length];setHandoffPtr(handoffPtr+1);
    transfer(leadId,b.id);setSelId(p=>p===leadId?null:p);
  }
  function handoffTo(leadId,bId){transfer(leadId,bId);setSelId(p=>p===leadId?null:p);}

  const NAV={
    adm:[["dashboard","grid","Painel"],["relatorios","chart","Relatórios"],["conexao","phone2","Conexão"]],
    sdr:[["catraca","transfer","Catraca"],["atendimento","msg","Atender"],["funil","columns","Funil"],["disp","toggleOn","Disponib."],["produtividade","trend","Produção"]],
    corretor:[["atendimento","msg","Atender"],["funil","columns","Funil"],["disp","toggleOn","Disponib."],["produtividade","trend","Produção"]],
  }[role];
  const TITLES={dashboard:"Painel da equipe",relatorios:"Relatório por corretor",conexao:"Conexão da Conecta",catraca:"Catraca de distribuição",equipe:"Equipe & disponibilidade",atendimento:"Atendimento",funil:"Meu funil",disp:"Minha disponibilidade",produtividade:"Minha produtividade"};

  const roleLabel=role==="adm"?"Administração":role==="sdr"?"SDR":"Corretor(a)";

  return <div style={{fontFamily:FONT,background:C.surface,color:C.ink,width:"100%",height:"100dvh",display:"flex",flexDirection:isMobile?"column":"row",overflow:"hidden"}}>
    {!isMobile&&<aside style={{background:C.greenDeep,width:74,flexShrink:0,display:"flex",flexDirection:"column",alignItems:"center",padding:"20px 0"}}>
      <div style={{background:C.green,width:40,height:40,borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",marginBottom:4}}><Icon n="dot" size={20}/></div>
      <div style={{fontFamily:DISPLAY,color:"#fff",fontSize:10,fontWeight:700,textAlign:"center",lineHeight:1.1,marginBottom:20}}>Con<br/>CRM</div>
      <div style={{display:"flex",flexDirection:"column",gap:4,flex:1}}>
        {NAV.map(([v,n,label])=><button key={v} onClick={()=>setView(v)} title={label} style={{width:52,padding:"8px 0",borderRadius:12,border:"none",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:4,background:view===v?"rgba(255,255,255,.14)":"transparent",color:view===v?"#fff":"rgba(255,255,255,.55)"}}><Icon n={n} size={19}/><span style={{fontSize:9,fontWeight:500}}>{label}</span></button>)}
      </div>
      <button onClick={()=>setSession(null)} title="Sair" style={{width:52,padding:"8px 0",borderRadius:12,border:"none",cursor:"pointer",background:"transparent",color:"rgba(255,255,255,.55)",display:"flex",flexDirection:"column",alignItems:"center",gap:4}}><Icon n="logout" size={18}/><span style={{fontSize:9}}>Sair</span></button>
    </aside>}
    <main style={{flex:1,display:"flex",flexDirection:"column",minWidth:0,minHeight:0}}>
      <header style={{background:C.card,borderBottom:`1px solid ${C.line}`,height:isMobile?52:58,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"space-between",padding:isMobile?"0 14px":"0 20px",gap:12}}>
        <div style={{display:"flex",alignItems:"center",gap:12,minWidth:0}}>
          <h1 style={{fontFamily:DISPLAY,color:C.ink,fontSize:isMobile?15.5:17,fontWeight:700,margin:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{TITLES[view]}</h1>
          {!isMobile&&<Pill c={C.greenMid} bg={C.greenSoft}>Campanha Jardim Amazonas</Pill>}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:isMobile?8:10,flexShrink:0}}>
          {!isMobile&&<div style={{textAlign:"right"}}><div style={{color:C.ink,fontSize:12.5,fontWeight:600,lineHeight:1}}>{session.name}</div><div style={{color:C.faint,fontSize:10.5}}>{roleLabel}</div></div>}
          <Avatar ini={session.ini} color={session.color} size={isMobile?30:34}/>
          {isMobile&&<button onClick={()=>setSession(null)} title="Sair" aria-label="Sair" style={{width:34,height:34,borderRadius:10,border:`1px solid ${C.line}`,background:C.surface,color:C.sub,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon n="logout" size={16}/></button>}
        </div>
      </header>
      <div style={{flex:1,minHeight:0}}>
        {canAttend&&view==="atendimento"&&<Atendimento {...{myLeads,sel,setSelId,draft,setDraft,send,setStatus,chatRef,conecta,session,canHandoff:role==="sdr",handoffNext,handoffTo,availCorretores,isMobile}}/>}
        {canAttend&&view==="funil"&&<Funil leads={myLeads} openLead={openLead} setStatus={setStatus} isMobile={isMobile}/>}
        {canAttend&&view==="disp"&&<Disponibilidade avail={avail[session.id]} toggle={()=>toggleAvail(session.id)} name={session.name}/>}
        {canAttend&&view==="produtividade"&&<Produtividade leads={leads} broker={session} isMobile={isMobile}/>}
        {role==="sdr"&&view==="catraca"&&<Catraca {...{leads,brokers:attendants,avail,toggleAvail,transfer,catracaNext,isMobile}}/>}
        {role==="adm"&&view==="dashboard"&&<Dashboard {...{leads,brokers:attendants,avail,setRepBroker,setView,isMobile}}/>}
        {role==="adm"&&view==="relatorios"&&<Produtividade leads={leads} broker={attendants.find(b=>b.id===repBroker)} pickable brokers={attendants} repBroker={repBroker} setRepBroker={setRepBroker} isMobile={isMobile}/>}
        {role==="adm"&&view==="conexao"&&<Conexao conecta={conecta} setConecta={setConecta}/>}
      </div>
    </main>
    {isMobile&&<nav style={{background:C.greenDeep,flexShrink:0,display:"flex",alignItems:"stretch",justifyContent:"space-around",paddingBottom:"env(safe-area-inset-bottom)"}}>
      {NAV.map(([v,n,label])=><button key={v} onClick={()=>setView(v)} style={{flex:1,minWidth:0,padding:"9px 2px 10px",border:"none",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:3,background:"transparent",color:view===v?"#fff":"rgba(255,255,255,.5)",borderTop:`2px solid ${view===v?C.green:"transparent"}`}}>
        <Icon n={n} size={20}/><span style={{fontSize:9.5,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"100%"}}>{label}</span>
      </button>)}
    </nav>}
  </div>;
}

/* ===== ATENDIMENTO ===== */
function Atendimento({myLeads,sel,setSelId,draft,setDraft,send,setStatus,chatRef,conecta,session,canHandoff,handoffNext,handoffTo,availCorretores,isMobile}){
  const [filter,setFilter]=useState("Todos");
  // No celular só cabe um painel por vez: lista → conversa → ficha.
  const [pane,setPane]=useState(()=>sel?"chat":"lista");
  const isCompact=useIsCompact();
  const fichaPorBotao=isMobile||isCompact; // ficha não cabe fixa ao lado
  const list=myLeads.filter(l=>filter==="Todos"?true:filter==="Aguardando"?l.firstRespAt==null:l.prio===filter.toUpperCase());
  const openChat=(id)=>{setSelId(id);setPane("chat");};
  // Se o lead sai da conta (repasse da SDR), volta sozinho para a lista.
  useEffect(()=>{if(!sel&&pane!=="lista")setPane("lista");},[sel,pane]);
  const showList=!isMobile||pane==="lista";
  const showChat=!!sel&&(isMobile?pane==="chat":(fichaPorBotao?pane!=="ficha":true));
  const showFicha=!!sel&&(fichaPorBotao?pane==="ficha":true);
  const backBtn=(onClick,label)=><button onClick={onClick} aria-label={label} style={{width:34,height:34,marginRight:2,borderRadius:10,border:"none",background:C.surface,color:C.sub,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transform:"scaleX(-1)"}}><Icon n="chevron" size={17}/></button>;

  return <div style={{height:"100%",display:"flex",minHeight:0}}>
    {showList&&<div style={{width:isMobile?"100%":isCompact?250:300,flexShrink:0,borderRight:isMobile?"none":`1px solid ${C.line}`,background:C.card,display:"flex",flexDirection:"column",minHeight:0}}>
      <div style={{padding:12,borderBottom:`1px solid ${C.line}`}}>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{["Todos","Aguardando","Quente","Morno"].map(f=><button key={f} onClick={()=>setFilter(f)} style={{fontSize:isMobile?12.5:11,fontWeight:500,padding:isMobile?"7px 14px":"4px 10px",borderRadius:999,border:"none",cursor:"pointer",background:filter===f?C.greenDeep:C.surface,color:filter===f?"#fff":C.sub}}>{f}</button>)}</div>
      </div>
      <div style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
        {list.length===0&&<div style={{color:C.faint,fontSize:13,textAlign:"center",padding:32}}>Nenhum lead aqui 🎉</div>}
        {list.map(l=>{const active=!isMobile&&sel&&sel.id===l.id,waiting=l.firstRespAt==null,age=Date.now()-l.createdAt,last=l.msgs.filter(m=>m.from!=="system").slice(-1)[0];
          return <button key={l.id} onClick={()=>openChat(l.id)} style={{width:"100%",textAlign:"left",padding:isMobile?"13px 14px":"10px 12px",borderBottom:`1px solid ${C.line}`,borderLeft:`3px solid ${active?C.green:"transparent"}`,background:active?C.greenSoft:"transparent",border:"none",cursor:"pointer",display:"flex",flexDirection:"column",gap:4}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}><span style={{color:C.ink,fontSize:13.5,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.nome}</span><Pill c={PRIO[l.prio].c} bg={PRIO[l.prio].bg}>{PRIO[l.prio].label}</Pill></div>
            <span style={{color:C.faint,fontSize:11.5,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{last?(last.from==="lead"?"":"Você: ")+last.text:"Novo lead — sem contato"}</span>
            {waiting?<div style={{display:"flex",alignItems:"center",gap:4,marginTop:2}}><Icon n="timer" size={12} color={ageColor(age)}/><span style={{color:ageColor(age),fontFamily:MONO,fontSize:11,fontWeight:600}}>aguardando há {fmtAge(age)}</span></div>:<span style={{color:STAGE_C[l.status],background:STAGE_C[l.status]+"16",fontSize:10,fontWeight:600,padding:"1px 6px",borderRadius:4,alignSelf:"flex-start",marginTop:2}}>{l.status}</span>}
          </button>;})}
      </div>
    </div>}
    {showChat&&<div style={{flex:1,display:"flex",flexDirection:"column",minWidth:0,minHeight:0,background:C.surface}}>
      <div style={{background:C.card,borderBottom:`1px solid ${C.line}`,height:56,display:"flex",alignItems:"center",justifyContent:"space-between",padding:isMobile?"0 10px":"0 16px",gap:8,flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:isMobile?8:12,minWidth:0}}>
          {isMobile&&backBtn(()=>setPane("lista"),"Voltar para a lista")}
          <Avatar ini={initials(sel.nome)} color={PRIO[sel.prio].c} size={36}/>
          <div style={{minWidth:0}}><div style={{color:C.ink,fontSize:14,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{sel.nome}</div><div style={{color:C.faint,fontSize:11.5,display:"flex",alignItems:"center",gap:4}}><Icon n="phone" size={11}/>{sel.tel}</div></div>
        </div>
        {fichaPorBotao
          ?<button onClick={()=>setPane("ficha")} style={{flexShrink:0,display:"flex",alignItems:"center",gap:5,border:`1px solid ${C.line}`,background:C.surface,color:C.sub,fontSize:12,fontWeight:600,padding:"7px 12px",borderRadius:10,cursor:"pointer"}}><Icon n="star" size={13} color={PRIO[sel.prio].c} fill={PRIO[sel.prio].c}/> Ficha</button>
          :<div style={{color:conecta.connected?C.green:C.faint,background:conecta.connected?C.greenSoft:C.coolSoft,fontSize:11,fontWeight:600,padding:"4px 10px",borderRadius:999,display:"flex",alignItems:"center",gap:4,flexShrink:0}}><Icon n={conecta.connected?"wifi":"wifioff"} size={12}/>Número da Conecta</div>}
      </div>
      <div ref={chatRef} style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",padding:isMobile?"14px 12px":"16px 20px",display:"flex",flexDirection:"column",gap:8,minHeight:0}}>
        {sel.msgs.length===0&&<div style={{color:C.faint,margin:"auto",textAlign:"center",maxWidth:280}}><Icon n="spark" size={22} color={C.green}/><div style={{fontSize:13,marginTop:8}}>Lead ainda não contatado.<br/>Use um modelo e fale agora — quanto mais rápido, maior a chance.</div></div>}
        {sel.msgs.map((m,i)=>{
          if(m.from==="system")return <div key={i} style={{alignSelf:"center",background:C.amberSoft,color:"#8a6d1f",fontSize:11,fontWeight:600,padding:"3px 10px",borderRadius:999,margin:"2px 0"}}>{m.text}</div>;
          const mine=m.from==="corretor";const senderName=m.byName||SEED_NAMES[m.by]||first(session.name);
          return <div key={i} style={{display:"flex",justifyContent:mine?"flex-end":"flex-start"}}>
            <div style={{maxWidth:isMobile?"86%":"74%",padding:"8px 12px",fontSize:13.5,lineHeight:1.35,borderRadius:16,background:mine?C.green:C.card,color:mine?"#fff":C.ink,border:mine?"none":`1px solid ${C.line}`,boxShadow:"0 1px 2px rgba(0,0,0,.04)",borderBottomRightRadius:mine?4:16,borderBottomLeftRadius:mine?16:4}}>
              {mine&&<div style={{fontSize:10.5,fontWeight:700,color:"rgba(255,255,255,.85)",marginBottom:2}}>{senderName} · Conecta</div>}
              {m.text}<div style={{color:mine?"rgba(255,255,255,.7)":C.faint,fontSize:10,marginTop:2,textAlign:"right"}}>{fmtClock(m.at)}</div>
            </div>
          </div>;})}
      </div>
      <div style={{background:C.card,borderTop:`1px solid ${C.line}`,padding:12,flexShrink:0}}>
        <div style={{display:"flex",gap:6,marginBottom:8,overflowX:"auto",paddingBottom:4}}>{TEMPLATES.map(tp=><button key={tp.t} onClick={()=>setDraft(tp.body)} style={{fontSize:11,fontWeight:500,padding:"4px 10px",borderRadius:999,border:"none",cursor:"pointer",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:4,color:C.greenMid,background:C.greenSoft}}><Icon n="zap" size={11}/> {tp.t}</button>)}</div>
        <div style={{display:"flex",alignItems:"flex-end",gap:8}}>
          {/* 16px no celular evita o zoom automático do iOS ao focar o campo */}
          <textarea value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey&&!isMobile){e.preventDefault();send();}}} rows={2} placeholder={isMobile?"Escreva a mensagem…":"Escreva a mensagem…  ({nome} vira o primeiro nome do lead)"} style={{flex:1,minWidth:0,fontSize:isMobile?16:13.5,borderRadius:12,border:`1px solid ${C.line}`,padding:"8px 12px",outline:"none",resize:"none",color:C.ink,background:C.surface,fontFamily:FONT}}/>
          <button onClick={send} style={{width:44,height:44,borderRadius:12,border:"none",cursor:"pointer",background:C.green,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon n="send" size={18}/></button>
        </div>
        <div style={{color:C.faint,fontSize:10.5,marginTop:6,display:"flex",alignItems:"center",gap:5}}><Icon n="msg" size={11} color={C.faint}/> Sai pelo número da Conecta, assinada como <b style={{color:C.sub}}>&nbsp;{first(session.name)}</b>.</div>
      </div>
    </div>}
    {!isMobile&&!sel&&<div style={{flex:1,background:C.surface}}/>}
    {showFicha&&<div style={{width:fichaPorBotao?"100%":264,flex:fichaPorBotao?1:"none",flexShrink:0,borderLeft:fichaPorBotao?"none":`1px solid ${C.line}`,background:C.card,overflowY:"auto",WebkitOverflowScrolling:"touch",minHeight:0}}>
      <div style={{padding:16}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
          {fichaPorBotao&&backBtn(()=>setPane("chat"),"Voltar para a conversa")}
          <Icon n="star" size={14} color={PRIO[sel.prio].c} fill={PRIO[sel.prio].c}/><span style={{color:C.ink,fontSize:13,fontWeight:700}}>Ficha do lead</span>
        </div>
        {canHandoff&&<div style={{background:C.greenSoft,border:`1px solid ${C.green}33`,borderRadius:12,padding:12,marginBottom:14}}>
          <div style={{color:C.greenDeep,fontSize:11.5,fontWeight:600,display:"flex",alignItems:"center",gap:5,marginBottom:6}}><Icon n="transfer" size={13} color={C.greenMid}/> Primeiro atendimento da SDR</div>
          <div style={{color:C.sub,fontSize:11.5,lineHeight:1.4,marginBottom:8}}>Faça o contato inicial e repasse — o lead sai da sua conta e vai para o corretor.</div>
          <button onClick={()=>handoffNext(sel.id)} disabled={!availCorretores.length} style={{width:"100%",background:availCorretores.length?C.green:C.coolSoft,color:availCorretores.length?"#fff":C.faint,border:"none",cursor:availCorretores.length?"pointer":"default",fontSize:12.5,fontWeight:600,padding:"9px",borderRadius:9,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}><Icon n="transfer" size={14}/> Passar para o corretor da vez</button>
          <div style={{color:C.faint,fontSize:10.5,margin:"8px 0 5px"}}>ou escolher um corretor:</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
            {availCorretores.length?availCorretores.map(b=><button key={b.id} onClick={()=>handoffTo(sel.id,b.id)} title={b.name} style={{display:"flex",alignItems:"center",gap:5,border:`1px solid ${C.line}`,background:C.card,borderRadius:999,padding:"3px 9px 3px 3px",cursor:"pointer"}}><Avatar ini={b.ini} color={b.color} size={20}/><span style={{color:C.ink,fontSize:11.5,fontWeight:500}}>{first(b.name)}</span></button>):<span style={{color:C.hot,fontSize:11}}>Nenhum corretor disponível agora.</span>}
          </div>
        </div>}
        <label style={{color:C.faint,fontSize:10.5,fontWeight:600,textTransform:"uppercase",letterSpacing:.5}}>Etapa do funil</label>
        <select value={sel.status} onChange={e=>setStatus(sel.id,e.target.value)} style={{width:"100%",marginTop:4,marginBottom:8,fontSize:isMobile?16:13,fontWeight:600,borderRadius:8,border:`1px solid ${C.line}`,padding:"8px 10px",outline:"none",color:STAGE_C[sel.status],background:C.surface}}>{STAGES.map(s=><option key={s} value={s}>{s}</option>)}</select>
        <div style={{color:C.faint,fontSize:10.5,marginBottom:12,lineHeight:1.4}}>A etapa avança sozinha conforme a conversa. Você pode ajustar manualmente aqui.</div>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {[["Renda familiar",sel.qual.renda,"target"],["Entrada",sel.qual.entrada,"check"],["Situação",sel.qual.situacao,"users"],["Restrição CPF",sel.qual.cpf,"award"],["Prazo p/ comprar",sel.qual.prazo,"calendar"]].map(([k,v,n])=><div key={k}><div style={{color:C.faint,fontSize:10.5,fontWeight:600,display:"flex",alignItems:"center",gap:4,marginBottom:2}}><Icon n={n} size={11}/>{k}</div><div style={{color:C.ink,fontSize:12.5,fontWeight:500}}>{v}</div></div>)}
        </div>
        <div style={{borderTop:`1px solid ${C.line}`,marginTop:16,paddingTop:12,display:"flex",flexDirection:"column",gap:6}}>
          <div style={{color:C.sub,fontSize:11.5,display:"flex",alignItems:"center",gap:6}}><Icon n="mail" size={12} color={C.faint}/> via {sel.origem}</div>
          <div style={{color:C.sub,fontSize:11.5,display:"flex",alignItems:"center",gap:6}}><Icon n="clock" size={12} color={C.faint}/> entrou há {fmtAge(Date.now()-sel.createdAt)}</div>
        </div>
      </div>
    </div>}
  </div>;
}

/* ===== FUNIL ===== */
function Funil({leads,openLead,setStatus,isMobile}){
  // No celular cada etapa ocupa quase a tela toda e o swipe encaixa de coluna em coluna.
  const colW=isMobile?"82vw":164;
  return <div style={{height:"100%",overflowX:"auto",overflowY:"hidden",WebkitOverflowScrolling:"touch",padding:isMobile?12:16,scrollSnapType:isMobile?"x mandatory":"none"}}>
    <div style={{display:"flex",gap:12,height:"100%",minWidth:isMobile?"auto":STAGES.length*172}}>
      {STAGES.map(st=>{const items=leads.filter(l=>l.status===st);
        return <div key={st} style={{width:colW,flexShrink:0,scrollSnapAlign:isMobile?"start":"none",display:"flex",flexDirection:"column",minHeight:0}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8,padding:"0 4px"}}><div style={{display:"flex",alignItems:"center",gap:6,minWidth:0}}><span style={{background:STAGE_C[st],width:8,height:8,borderRadius:"50%",flexShrink:0}}/><span style={{color:C.ink,fontSize:12,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{st}</span></div><span style={{color:C.faint,fontFamily:MONO,fontSize:11,fontWeight:600}}>{items.length}</span></div>
          <div style={{flex:1,borderRadius:12,border:`1px solid ${C.line}`,background:C.surface,padding:6,overflowY:"auto",display:"flex",flexDirection:"column",gap:6}}>
            {items.map(l=>{const waiting=l.firstRespAt==null,age=Date.now()-l.createdAt;
              return <div key={l.id} style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:8,padding:8}}>
                <button onClick={()=>openLead(l.id)} style={{width:"100%",textAlign:"left",border:"none",background:"transparent",cursor:"pointer",padding:0}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:4}}><span style={{color:C.ink,fontSize:12,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.nome}</span><span style={{background:PRIO[l.prio].c,width:6,height:6,borderRadius:"50%",flexShrink:0}}/></div>
                  {waiting&&<div style={{display:"flex",alignItems:"center",gap:4,marginTop:4}}><Icon n="timer" size={10} color={ageColor(age)}/><span style={{color:ageColor(age),fontFamily:MONO,fontSize:10,fontWeight:600}}>{fmtAge(age)}</span></div>}
                </button>
              </div>;})}
            {items.length===0&&<div style={{color:C.faint,fontSize:10.5,textAlign:"center",padding:"12px 0"}}>—</div>}
          </div>
        </div>;})}
    </div>
  </div>;
}

/* ===== DISPONIBILIDADE (corretor) ===== */
function Disponibilidade({avail,toggle,name}){
  return <div style={{height:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch",padding:16}}>
    <div style={{maxWidth:520,margin:"0 auto"}}>
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:24,textAlign:"center"}}>
        <div style={{background:avail?C.greenSoft:C.coolSoft,width:64,height:64,borderRadius:16,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px",color:avail?C.green:C.cool}}><Icon n={avail?"toggleOn":"toggleOff"} size={30}/></div>
        <div style={{color:C.ink,fontFamily:DISPLAY,fontSize:18,fontWeight:700}}>{avail?"Você está disponível hoje":"Você está indisponível"}</div>
        <div style={{color:C.sub,fontSize:13,marginTop:6,lineHeight:1.5}}>{avail?"A SDR pode te transferir novos leads da campanha na catraca de hoje.":"Enquanto indisponível, você não entra na catraca e não recebe leads novos. Fale com a SDR e ative aqui."}</div>
        <button onClick={toggle} style={{marginTop:18,background:avail?C.coolSoft:C.green,color:avail?C.sub:"#fff",border:"none",cursor:"pointer",fontSize:14,fontWeight:600,padding:"10px 22px",borderRadius:12}}>{avail?"Ficar indisponível":"Me prontificar para atendimento"}</button>
      </div>
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:20,marginTop:16}}>
        <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:8,display:"flex",alignItems:"center",gap:8}}><Icon n="transfer" size={15} color={C.green}/> Como funciona a catraca</div>
        <div style={{color:C.sub,fontSize:12.5,lineHeight:1.6}}>Só recebe lead quem se prontifica no dia. A SDR confirma a sua disponibilidade e transfere os leads manualmente, um a um, apenas para quem está ativo — mantendo a fila justa.</div>
      </div>
    </div>
  </div>;
}

/* ===== CATRACA (SDR) ===== */
function Catraca({leads,brokers,avail,toggleAvail,transfer,catracaNext,isMobile}){
  const novos=leads.filter(l=>l.assignedTo===null).sort((a,b)=>({QUENTE:0,MORNO:1,FRIO:2}[a.prio]-{QUENTE:0,MORNO:1,FRIO:2}[b.prio]));
  const disp=brokers.filter(b=>avail[b.id]);
  return <div style={{height:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch",padding:isMobile?14:20}}>
    <div style={{maxWidth:860,margin:"0 auto"}}>
      {/* roster de disponibilidade */}
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16,marginBottom:16}}>
        <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:10,display:"flex",alignItems:"center",gap:8}}><Icon n="users" size={15} color={C.green}/> Disponíveis hoje ({disp.length}/{brokers.length})</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {brokers.map(b=>{const on=avail[b.id];return <button key={b.id} onClick={()=>toggleAvail(b.id)} style={{display:"flex",alignItems:"center",gap:8,border:`1px solid ${on?C.green:C.line}`,background:on?C.greenSoft:C.card,borderRadius:999,padding:"5px 12px 5px 5px",cursor:"pointer"}}>
            <Avatar ini={b.ini} color={b.color} size={26}/><span style={{color:C.ink,fontSize:12.5,fontWeight:600}}>{first(b.name)}</span><Icon n={on?"toggleOn":"toggleOff"} size={18} color={on?C.green:C.faint}/></button>;})}
        </div>
        <div style={{color:C.faint,fontSize:11,marginTop:8}}>Clique para marcar quem falou com você e está pronto para atender. Só quem está verde entra na catraca.</div>
      </div>

      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
        <div><div style={{color:C.ink,fontFamily:DISPLAY,fontSize:16,fontWeight:700}}>{novos.length} lead(s) na fila</div><div style={{color:C.faint,fontSize:12}}>Transfira manualmente para quem está disponível.</div></div>
      </div>
      {novos.length===0&&<div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:40,textAlign:"center"}}><Icon n="check" size={30} color={C.green}/><div style={{color:C.ink,fontSize:14,fontWeight:600,marginTop:8}}>Fila zerada</div><div style={{color:C.faint,fontSize:12,marginTop:4}}>Novos leads da campanha caem aqui automaticamente.</div></div>}
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {novos.map(l=>{const age=Date.now()-l.createdAt;
          return <div key={l.id} style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:12}}>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <Avatar ini={initials(l.nome)} color={PRIO[l.prio].c} size={38}/>
              <div style={{minWidth:0,flex:1}}><div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}><span style={{color:C.ink,fontSize:13.5,fontWeight:600}}>{l.nome}</span><Pill c={PRIO[l.prio].c} bg={PRIO[l.prio].bg}>{PRIO[l.prio].label}</Pill></div><div style={{color:C.faint,fontSize:11.5}}>{l.qual.renda} · {l.qual.prazo}</div></div>
              <div style={{display:"flex",alignItems:"center",gap:4,marginRight:4,flexShrink:0}}><Icon n="timer" size={13} color={ageColor(age)}/><span style={{color:ageColor(age),fontFamily:MONO,fontSize:12,fontWeight:600}}>{fmtAge(age)}</span></div>
              {/* no celular o botão desce para a linha de baixo, em largura total */}
              {!isMobile&&<button onClick={()=>catracaNext(l.id)} disabled={!disp.length} style={{background:disp.length?C.greenDeep:C.coolSoft,color:disp.length?"#fff":C.faint,border:"none",cursor:disp.length?"pointer":"default",fontSize:12,fontWeight:600,padding:"8px 12px",borderRadius:10,display:"flex",alignItems:"center",gap:6,whiteSpace:"nowrap"}}><Icon n="transfer" size={14}/> Próximo</button>}
            </div>
            {isMobile&&<button onClick={()=>catracaNext(l.id)} disabled={!disp.length} style={{width:"100%",marginTop:10,background:disp.length?C.greenDeep:C.coolSoft,color:disp.length?"#fff":C.faint,border:"none",cursor:disp.length?"pointer":"default",fontSize:13,fontWeight:600,padding:"11px",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}><Icon n="transfer" size={14}/> Passar para o próximo</button>}
            <div style={{display:"flex",alignItems:"center",gap:6,marginTop:10,paddingTop:10,borderTop:`1px solid ${C.line}`,flexWrap:"wrap"}}>
              <span style={{color:C.faint,fontSize:11,fontWeight:600}}>Transferir para:</span>
              {disp.length?disp.map(b=><button key={b.id} onClick={()=>transfer(l.id,b.id)} title={b.name} style={{display:"flex",alignItems:"center",gap:6,border:`1px solid ${C.line}`,background:C.surface,borderRadius:999,padding:"3px 10px 3px 3px",cursor:"pointer"}}><Avatar ini={b.ini} color={b.color} size={22}/><span style={{color:C.ink,fontSize:12,fontWeight:500}}>{first(b.name)}</span></button>):<span style={{color:C.hot,fontSize:11.5}}>Ninguém disponível — marque um corretor acima.</span>}
            </div>
          </div>;})}
      </div>
    </div>
  </div>;
}

/* ===== EQUIPE (SDR) ===== */
function Equipe({brokers,avail,toggleAvail,leads}){
  return <div style={{height:"100%",overflowY:"auto",padding:20}}>
    <div style={{maxWidth:720,margin:"0 auto",display:"flex",flexDirection:"column",gap:10}}>
      {brokers.map(b=>{const on=avail[b.id],count=leads.filter(l=>l.assignedTo===b.id).length,ativos=leads.filter(l=>l.assignedTo===b.id&&LINEAR.indexOf(l.status)>=0&&l.status!=="Venda").length;
        return <div key={b.id} style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:14,display:"flex",alignItems:"center",gap:12}}>
          <Avatar ini={b.ini} color={b.color} size={40}/>
          <div style={{flex:1,minWidth:0}}><div style={{color:C.ink,fontSize:14,fontWeight:600}}>{b.name}</div><div style={{color:C.faint,fontSize:11.5}}>{count} leads · {ativos} em atendimento</div></div>
          <button onClick={()=>toggleAvail(b.id)} style={{display:"flex",alignItems:"center",gap:6,border:"none",cursor:"pointer",background:on?C.greenSoft:C.coolSoft,color:on?C.greenMid:C.sub,fontSize:12,fontWeight:600,padding:"6px 12px",borderRadius:999}}><Icon n={on?"toggleOn":"toggleOff"} size={18}/> {on?"Disponível":"Indisponível"}</button>
        </div>;})}
    </div>
  </div>;
}

/* ===== CONEXÃO (ADM, número único) ===== */
function Conexao({conecta,setConecta}){
  const [num,setNum]=useState("");const [busy,setBusy]=useState(false);
  const isMobile=useIsMobile();
  function connect(){if(!num.trim())return;setBusy(true);setTimeout(()=>{setConecta({connected:true,number:num});setBusy(false);setNum("");},1300);}
  return <div style={{height:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch",padding:isMobile?14:24}}>
    <div style={{maxWidth:560,margin:"0 auto"}}>
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:24,textAlign:"center"}}>
        <div style={{background:conecta.connected?C.greenSoft:C.amberSoft,width:64,height:64,borderRadius:16,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px",color:conecta.connected?C.green:C.amber}}><Icon n={conecta.connected?"wifi":"phone2"} size={28}/></div>
        <div style={{color:C.ink,fontFamily:DISPLAY,fontSize:18,fontWeight:700}}>{conecta.connected?"WhatsApp da Conecta conectado":"Conectar o WhatsApp da Conecta"}</div>
        {conecta.connected?<React.Fragment>
          <div style={{color:C.sub,fontSize:13,marginTop:4}}>Todos os corretores atendem por este número:</div>
          <div style={{color:C.green,fontFamily:MONO,fontSize:16,fontWeight:600,margin:"8px 0"}}>{conecta.number}</div>
          <Pill c={C.greenMid} bg={C.greenSoft}>Ativo via Uazapi</Pill>
          <div><button onClick={()=>setConecta({connected:false,number:""})} style={{marginTop:16,background:"transparent",color:C.hot,border:"none",cursor:"pointer",fontSize:12,fontWeight:600}}>Desconectar</button></div>
        </React.Fragment>:<React.Fragment>
          <div style={{color:C.sub,fontSize:13,margin:"6px 0 14px"}}>Informe o número da Conecta. A conexão é feita via instância Uazapi (QR / código de pareamento).</div>
          <div style={{display:"flex",gap:8,flexDirection:isMobile?"column":"row"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,border:`1px solid ${C.line}`,background:C.surface,borderRadius:10,padding:"0 12px",flex:1,minWidth:0}}><Icon n="phone" size={14} color={C.faint}/><input value={num} onChange={e=>setNum(e.target.value)} type="tel" inputMode="tel" placeholder="+55 (87) 9 9999-9999" style={{border:"none",outline:"none",background:"transparent",fontSize:isMobile?16:13,padding:"10px 0",width:"100%",color:C.ink}}/></div>
            <button onClick={connect} disabled={busy} style={{background:busy?C.faint:C.greenDeep,color:"#fff",border:"none",cursor:"pointer",fontSize:isMobile?14:12.5,fontWeight:600,padding:isMobile?"12px 18px":"0 18px",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>{busy?<React.Fragment><Icon n="loader" size={14} spin/> Conectando…</React.Fragment>:"Conectar"}</button>
          </div>
        </React.Fragment>}
      </div>
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:20,marginTop:16}}>
        <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:8,display:"flex",alignItems:"center",gap:8}}><Icon n="link" size={15} color={C.green}/> Como funciona</div>
        <div style={{color:C.sub,fontSize:12.5,lineHeight:1.6}}>Um único número da Conecta conectado via Uazapi. Todos os corretores atendem por ele, e cada mensagem sai assinada com o nome de quem enviou — o lead sempre sabe com quem está falando.</div>
      </div>
    </div>
  </div>;
}

/* ===== PRODUTIVIDADE ===== */
function computeStats(leads,id){
  const mine=leads.filter(l=>l.assignedTo===id);
  const at=mine.filter(l=>l.firstRespAt!=null);
  const resp=at.map(l=>(l.firstRespAt-l.createdAt)/60000);
  const avg=resp.length?Math.round(resp.reduce((a,b)=>a+b,0)/resp.length):0;
  const c=(s)=>mine.filter(l=>l.status===s).length;
  const fech=c("Venda"),ag=c("Agendamento")+c("Visita");
  return {recebidos:mine.length,atendidos:at.length,avg,fech,ag,conv:mine.length?Math.round(fech/mine.length*100):0,taxa:mine.length?Math.round(at.length/mine.length*100):0,byStage:STAGES.reduce((o,s)=>(o[s]=c(s),o),{})};
}
function Produtividade({leads,broker,pickable,brokers,repBroker,setRepBroker,isMobile}){
  if(!broker)return null;const s=computeStats(leads,broker.id);
  return <div style={{height:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch",padding:isMobile?14:20}}>
    <div style={{maxWidth:920,margin:"0 auto"}}>
      {pickable&&<div style={{display:"flex",gap:8,marginBottom:16,flexWrap:isMobile?"nowrap":"wrap",overflowX:isMobile?"auto":"visible",paddingBottom:isMobile?4:0}}>{brokers.map(b=><button key={b.id} onClick={()=>setRepBroker(b.id)} style={{display:"flex",alignItems:"center",gap:8,border:`1px solid ${repBroker===b.id?C.green:C.line}`,background:repBroker===b.id?C.greenSoft:C.card,borderRadius:999,padding:"4px 12px 4px 4px",cursor:"pointer"}}><Avatar ini={b.ini} color={b.color} size={26}/><span style={{color:C.ink,fontSize:13,fontWeight:500}}>{first(b.name)}</span></button>)}</div>}
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16,marginBottom:16,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
        <Avatar ini={broker.ini} color={broker.color} size={46}/>
        <div style={{minWidth:0}}><div style={{color:C.ink,fontFamily:DISPLAY,fontSize:isMobile?16:18,fontWeight:700}}>{broker.name}</div><div style={{color:C.faint,fontSize:12}}>Corretor(a) · Conecta · últimas 24h</div></div>
        <div style={{marginLeft:"auto",textAlign:"right"}}><div style={{color:s.avg<=10?C.green:s.avg<=30?C.amber:C.hot,fontFamily:MONO,fontSize:isMobile?26:30,fontWeight:600,lineHeight:1}}>{s.avg}<span style={{fontSize:15}}> min</span></div><div style={{color:C.faint,fontSize:11,marginTop:4}}>tempo médio de 1ª resposta</div></div>
      </div>
      <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:16}}>
        <Metric n="users" label="Leads recebidos" value={s.recebidos} accent={C.cool}/>
        <Metric n="msg" label="Atendidos" value={s.atendidos} sub={s.taxa+"% de resposta"} accent={C.green}/>
        <Metric n="calendar" label="Agendados / visitas" value={s.ag} accent="#3B7BC4"/>
        <Metric n="check" label="Vendas" value={s.fech} sub={s.conv+"% de conversão"} accent={C.greenDeep}/>
      </div>
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16}}>
        <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:12}}>Avanço pelas etapas do funil</div>
        {STAGES.map(st=>{const v=s.byStage[st],pct=s.recebidos?v/s.recebidos*100:0;
          return <div key={st} style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}><span style={{color:C.sub,fontSize:11.5,width:isMobile?104:150,flexShrink:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{st}</span><div style={{height:10,borderRadius:999,background:C.surface,flex:1,overflow:"hidden"}}><div style={{width:Math.max(pct,v?6:0)+"%",height:"100%",borderRadius:999,background:STAGE_C[st]}}/></div><span style={{color:C.ink,fontFamily:MONO,fontSize:12,fontWeight:600,width:20,textAlign:"right"}}>{v}</span></div>;})}
      </div>
    </div>
  </div>;
}

/* ===== DASHBOARD (ADM) ===== */
function Dashboard({leads,brokers,avail,setRepBroker,setView,isMobile}){
  const team=brokers.map(b=>({b,s:computeStats(leads,b.id)}));
  const tot=(k)=>team.reduce((a,t)=>a+t.s[k],0);
  const avgAll=(()=>{const a=team.map(t=>t.s.avg).filter(x=>x>0);return a.length?Math.round(a.reduce((x,y)=>x+y,0)/a.length):0;})();
  const novos=leads.filter(l=>l.assignedTo===null).length;
  const ranked=[...team].sort((a,b)=>b.s.fech-a.s.fech||b.s.conv-a.s.conv);
  const stageTot=STAGES.map(st=>({st,v:leads.filter(l=>l.status===st).length}));
  const maxBar=Math.max(1,...team.map(t=>t.s.recebidos));
  return <div style={{height:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch",padding:isMobile?14:20}}>
    <div style={{maxWidth:1020,margin:"0 auto"}}>
      {novos>0&&<div style={{background:C.hotSoft,border:`1px solid ${C.hot}40`,borderRadius:12,padding:12,marginBottom:16,display:"flex",alignItems:"center",gap:12}}><Icon n="flame" size={18} color={C.hot}/><span style={{color:C.ink,fontSize:13,fontWeight:500}}>{novos} lead(s) na fila da SDR aguardando distribuição.</span></div>}
      <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:16}}>
        <Metric n="users" label="Leads na equipe" value={tot("recebidos")} accent={C.cool}/>
        <Metric n="clock" label="1ª resposta (média)" value={avgAll+" min"} sub="meta: até 10 min" accent={avgAll<=10?C.green:C.amber}/>
        <Metric n="calendar" label="Agendados" value={tot("ag")} accent="#3B7BC4"/>
        <Metric n="check" label="Vendas" value={tot("fech")} accent={C.greenDeep}/>
      </div>
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16,marginBottom:16}}>
        <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:12}}>Avanço de leads por etapa (equipe)</div>
        <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:4}}>
          {stageTot.map(({st,v})=><div key={st} style={{flexShrink:0,width:92}}><div style={{background:STAGE_C[st]+"14",border:`1px solid ${STAGE_C[st]}40`,borderRadius:12,padding:8,textAlign:"center"}}><div style={{color:STAGE_C[st],fontFamily:MONO,fontSize:20,fontWeight:700,lineHeight:1}}>{v}</div><div style={{color:C.sub,fontSize:10,marginTop:4,lineHeight:1.1}}>{st}</div></div></div>)}
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"3fr 2fr",gap:16}} className="dashgrid">
        <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16}}>
          <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:14}}>Comparativo por corretor</div>
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            {team.map(t=><div key={t.b.id}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:4}}><span style={{color:C.ink,fontWeight:600}}>{first(t.b.name)}</span><span style={{color:C.faint,fontFamily:MONO}}>{t.s.recebidos} leads · {t.s.fech} vendas</span></div>
              <div style={{display:"flex",height:16,borderRadius:6,overflow:"hidden",background:C.surface}}>
                <div style={{width:t.s.recebidos/maxBar*100+"%",background:C.cool,height:"100%"}} title="recebidos"/>
                <div style={{width:t.s.atendidos/maxBar*100+"%",background:C.green,height:"100%"}} title="atendidos"/>
                <div style={{width:t.s.fech/maxBar*100+"%",background:C.greenDeep,height:"100%"}} title="vendas"/>
              </div>
            </div>)}
          </div>
          <div style={{display:"flex",gap:14,marginTop:12}}>{[["Recebidos",C.cool],["Atendidos",C.green],["Vendas",C.greenDeep]].map(([l,c])=><div key={l} style={{display:"flex",alignItems:"center",gap:5}}><span style={{width:10,height:10,borderRadius:3,background:c}}/><span style={{color:C.sub,fontSize:11}}>{l}</span></div>)}</div>
        </div>
        <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16}}>
          <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:12}}>Ranking & tempo de resposta</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {ranked.map((t,i)=><button key={t.b.id} onClick={()=>{setRepBroker(t.b.id);setView("relatorios");}} style={{width:"100%",display:"flex",alignItems:"center",gap:10,borderRadius:12,padding:10,textAlign:"left",border:"none",cursor:"pointer",background:C.surface}}>
              <span style={{color:i===0?C.green:C.faint,fontFamily:MONO,fontSize:14,fontWeight:700,width:20}}>{i+1}º</span>
              <Avatar ini={t.b.ini} color={t.b.color} size={30}/>
              <div style={{minWidth:0,flex:1}}><div style={{color:C.ink,fontSize:13,fontWeight:600,display:"flex",alignItems:"center",gap:4}}>{first(t.b.name)} <span style={{color:avail[t.b.id]?C.green:C.faint,display:"inline-flex"}}><Icon n={avail[t.b.id]?"toggleOn":"toggleOff"} size={13}/></span></div><div style={{color:t.s.avg<=10?C.green:C.amber,fontSize:11,fontWeight:500}}>{t.s.avg} min · {t.s.conv}% conv.</div></div>
              <div style={{textAlign:"right"}}><div style={{color:C.greenDeep,fontFamily:MONO,fontSize:16,fontWeight:700}}>{t.s.fech}</div><div style={{color:C.faint,fontSize:10}}>vendas</div></div>
            </button>)}
          </div>
        </div>
      </div>
    </div>
  </div>;
}

ReactDOM.createRoot(document.getElementById("root")).render(<ConCRM/>);
