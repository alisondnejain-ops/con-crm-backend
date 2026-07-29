const { useState, useEffect, useMemo, useRef } = React;

/* ===== IDENTIDADE ===== */
const C = {
  ink:"#14181F", sub:"#5A6472", faint:"#8A93A0", line:"#E6E9E7", surface:"#F4F6F5", card:"#FFFFFF",
  green:"#0E8F6E", greenDeep:"#0A3D30", greenMid:"#0C6B52", greenSoft:"#E5F2EC",
  hot:"#E1553A", hotSoft:"#FBE7E1", amber:"#C8912B", amberSoft:"#F7EFD9", cool:"#5C6B7A", coolSoft:"#ECEFF2", white:"#FFF",
};
const DISPLAY="'Sora',sans-serif", FONT="'Inter',sans-serif", MONO="'IBM Plex Mono',monospace";
const ADM_CODE="CONECTA-JAZ-2026";

/* ===== API (backend hospedado) =====
   Para apontar para outro servidor sem recompilar, defina window.CON_CRM_API no index.html. */
const API=(typeof window!=="undefined"&&window.CON_CRM_API||"https://con-crm-backend-production.up.railway.app").replace(/\/$/,"");
const CADASTRO_URL=`${API}/cadastro?c=${ADM_CODE}`;

// Token guardado no navegador para o corretor não ter que logar toda vez (importante no celular).
const STORE="concrm_token";
let TOKEN=null;
try{ TOKEN=localStorage.getItem(STORE); }catch(e){}
function setToken(t){ TOKEN=t; try{ t?localStorage.setItem(STORE,t):localStorage.removeItem(STORE); }catch(e){} }

async function api(path,{method="GET",body}={}){
  let res;
  try{
    res=await fetch(API+path,{method,
      headers:{...(body?{"Content-Type":"application/json"}:{}),...(TOKEN?{Authorization:"Bearer "+TOKEN}:{})},
      body:body?JSON.stringify(body):undefined});
  }catch(e){ throw new Error("Sem conexão com o servidor. Confira sua internet e tente de novo."); }
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error||`Erro ${res.status} ao falar com o servidor.`);
  return data;
}

/* ===== tradução backend -> telas =====
   O backend fala em name/phone/stage; as telas nasceram falando nome/tel/status.
   Traduzimos aqui, num lugar só, em vez de espalhar a mudança por tudo. */
const QUAL_VAZIA={renda:"—",entrada:"—",situacao:"—",cpf:"—",prazo:"—"};
function adaptLead(l,anterior){
  return {
    id:l.id, nome:l.name||"Sem nome", tel:l.phone||"", email:l.email||"",
    prio:l.priority||"MORNO", origem:l.origem||"WhatsApp",
    createdAt:l.created_at, firstRespAt:l.first_resp_at,
    assignedTo:l.assigned_to, assignedName:l.assigned_name,
    status:l.stage||"Lead",
    qual:{...QUAL_VAZIA,...(l.qual||{})},
    unread:l.unread||0, lastBody:l.last_body, lastDirection:l.last_direction, lastAt:l.last_at,
    venda:l.sale_value?{valor:l.sale_value,data:l.sale_date,imovel:l.sale_property}:null,
    // As mensagens só chegam ao abrir a conversa; preservamos as já carregadas.
    msgs:l.messages?l.messages.map(adaptMsg):(anterior?anterior.msgs:[]),
    carregado:!!l.messages||(anterior?anterior.carregado:false),
  };
}
const adaptMsg=(m)=>({
  from:m.direction==="in"?"lead":"corretor",
  text:m.body, at:m.created_at, by:m.from_user_id, byName:m.from_name,
});
const PRIO={QUENTE:{c:C.hot,bg:C.hotSoft,label:"Quente"},MORNO:{c:C.amber,bg:C.amberSoft,label:"Morno"},FRIO:{c:C.cool,bg:C.coolSoft,label:"Frio"}};
const STAGES=["Lead","Atendimento","Pasta","Aprovação","Agendamento","Visita","Proposta","Venda","Perdido","Recaptação","Transferido por ligação"];
const LINEAR=["Lead","Atendimento","Pasta","Aprovação","Agendamento","Visita","Proposta","Venda"];
const STAGE_C={"Lead":"#64748B","Atendimento":"#0E8F6E","Pasta":"#0C6B52","Aprovação":"#2F80C4","Agendamento":"#7A5AD6","Visita":"#C8912B","Proposta":"#D97706","Venda":"#0A3D30","Perdido":"#B0463A","Recaptação":"#B07C1F","Transferido por ligação":"#5C6B7A"};

/* O avanço automático de etapa agora acontece no backend (services/stages.js).
   O frontend só exibe a etapa que o servidor devolve — uma fonte da verdade só. */


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
const initials=(n)=>String(n||"?").trim().split(/\s+/).map(x=>x[0]).slice(0,2).join("").toUpperCase();
const first=(n)=>String(n||"").split(" ")[0];
// O backend guarda 5587991234567; aqui mostramos legível.
function fmtTel(t){
  const d=String(t||"").replace(/\D/g,"");
  if(d.length===13) return `+55 (${d.slice(2,4)}) ${d.slice(4,9)}-${d.slice(9)}`;
  if(d.length===12) return `+55 (${d.slice(2,4)}) ${d.slice(4,8)}-${d.slice(8)}`;
  return t||"—";
}
const fmtMoeda=(v)=>(v||0).toLocaleString("pt-BR",{style:"currency",currency:"BRL",maximumFractionDigits:0});
const fmtData=(ms)=>ms?new Date(ms).toLocaleDateString("pt-BR"):"—";
// Abre o discador do celular com o número já preenchido.
function BotaoLigar({tel,compacto}){
  if(!tel) return null;
  return <a href={"tel:+"+String(tel).replace(/\D/g,"")} title="Ligar para o lead" aria-label="Ligar"
    style={{display:"flex",alignItems:"center",gap:6,textDecoration:"none",border:`1px solid ${C.line}`,background:C.surface,color:C.greenMid,fontSize:12,fontWeight:600,padding:compacto?"8px":"7px 12px",borderRadius:10}}>
    <Icon n="phone" size={14}/>{!compacto&&"Ligar"}
  </a>;
}

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

/* ===== LOGIN (contas reais, via backend) ===== */
function Auth({onLogin}){
  const [f,setF]=useState({email:"",pass:""});
  const [err,setErr]=useState("");
  const [busy,setBusy]=useState(false);
  const isMobile=useIsMobile();
  const set=(k)=>(e)=>setF({...f,[k]:e.target.value});
  async function entrar(){
    if(!f.email.trim()||!f.pass) return setErr("Preencha e-mail e senha.");
    setErr(""); setBusy(true);
    try{
      const d=await api("/auth/login",{method:"POST",body:{email:f.email.trim(),password:f.pass}});
      setToken(d.token); onLogin(d.user);
    }catch(e){ setErr(e.message); }
    finally{ setBusy(false); }
  }
  const onEnter=(e)=>{ if(e.key==="Enter") entrar(); };
  return <div style={{fontFamily:FONT,background:C.surface,width:"100%",minHeight:"100dvh",display:"flex",alignItems:isMobile?"stretch":"center",justifyContent:"center",padding:isMobile?0:24}}>
    <div style={{width:"100%",maxWidth:isMobile?"none":860,display:"grid",gridTemplateColumns:"1fr 1fr",borderRadius:isMobile?0:24,overflow:"hidden",boxShadow:isMobile?"none":"0 20px 60px rgba(0,0,0,.12)",border:isMobile?"none":`1px solid ${C.line}`}} className="authgrid">
      <div style={{background:C.greenDeep,padding:isMobile?"24px 22px":32,color:"#fff",display:"flex",flexDirection:"column",justifyContent:"space-between",gap:isMobile?16:0,minHeight:isMobile?0:460}}>
        <Brand size={isMobile?38:44}/>
        <div><div style={{fontFamily:DISPLAY,fontSize:isMobile?21:26,fontWeight:700,lineHeight:1.15,marginBottom:isMobile?8:12}}>Cada lead na mão certa, no tempo certo.</div>
          {!isMobile&&<p style={{color:"rgba(255,255,255,.75)",fontSize:13,lineHeight:1.6}}>Todos atendem pelo número da Conecta, cada mensagem assinada com o nome do corretor. A SDR distribui na catraca, e o funil avança sozinho conforme a conversa evolui.</p>}</div>
        {!isMobile&&<div style={{color:"rgba(255,255,255,.5)",fontSize:11}}>Acesso restrito à equipe da Conecta</div>}
      </div>
      <div style={{background:C.card,padding:isMobile?"24px 22px 40px":32,display:"flex",flexDirection:"column",justifyContent:"center"}}>
        <div style={{fontFamily:DISPLAY,color:C.ink,fontSize:20,fontWeight:700,marginBottom:4}}>Entrar</div>
        <div style={{color:C.sub,fontSize:13,marginBottom:22,lineHeight:1.5}}>Use o e-mail e a senha que você criou no seu cadastro.</div>
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <Field n="mail" type="email" autoComplete="email" inputMode="email" placeholder="E-mail" value={f.email} onChange={set("email")} onKeyDown={onEnter}/>
          <Field n="lock" type="password" autoComplete="current-password" placeholder="Senha" value={f.pass} onChange={set("pass")} onKeyDown={onEnter}/>
          {err&&<div style={{color:C.hot,background:C.hotSoft,fontSize:12.5,borderRadius:8,padding:"10px 12px",lineHeight:1.45}}>{err}</div>}
          <button onClick={entrar} disabled={busy} style={{background:busy?C.faint:C.green,color:"#fff",fontSize:15,fontWeight:600,padding:"13px",borderRadius:12,border:"none",cursor:busy?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
            {busy?<React.Fragment><Icon n="loader" size={16} spin/> Entrando…</React.Fragment>:<React.Fragment>Entrar <Icon n="arrow" size={16}/></React.Fragment>}
          </button>
        </div>
        <div style={{borderTop:`1px solid ${C.line}`,marginTop:22,paddingTop:18,textAlign:"center"}}>
          <div style={{color:C.sub,fontSize:12.5,marginBottom:10}}>Ainda não tem conta?</div>
          <a href={CADASTRO_URL} style={{display:"inline-flex",alignItems:"center",gap:7,textDecoration:"none",border:`1px solid ${C.line}`,background:C.surface,color:C.greenMid,fontSize:13.5,fontWeight:600,padding:"11px 18px",borderRadius:12}}>
            <Icon n="userplus" size={15}/> Criar minha conta
          </a>
          <div style={{color:C.faint,fontSize:11,marginTop:10,lineHeight:1.5}}>Você vai receber um e-mail para confirmar e definir sua senha.</div>
        </div>
      </div>
    </div>
  </div>;
}
function Field({n,...p}){return <div style={{display:"flex",alignItems:"center",gap:8,border:`1px solid ${C.line}`,background:C.surface,borderRadius:12,padding:"0 12px"}}><Icon n={n} size={16} color={C.faint}/><input {...p} style={{flex:1,fontSize:13.5,padding:"10px 0",outline:"none",border:"none",background:"transparent",color:C.ink,width:"100%"}}/></div>;}

/* ===== APP ===== */
const COLORS=["#0E8F6E","#3B7BC4","#C8912B","#7A5AD6","#B0463A","#0C6B52"];
// Converte o usuário que veio do backend no formato que as telas usam (inicial, cor).
function toSession(u){
  const h=[...(u.id||u.email||"")].reduce((a,c)=>a+c.charCodeAt(0),0);
  return {id:u.id,name:u.name,email:u.email,role:u.role,ini:initials(u.name),
          color:u.role==="adm"?C.greenDeep:COLORS[h%COLORS.length]};
}
const INTERVALO_ATUALIZACAO=10000; // busca novidades a cada 10s

function ConCRM(){
  const [session,setSession]=useState(null);
  const [carregando,setCarregando]=useState(!!TOKEN);
  const [leads,setLeads]=useState([]);
  const [fila,setFila]=useState([]);
  const [equipe,setEquipe]=useState([]);
  const [conecta,setConecta]=useState({connected:false,number:""});
  const [erro,setErro]=useState("");
  const [selId,setSelId]=useState(null);
  const selRef=useRef(null); selRef.current=selId;

  useEffect(()=>{
    if(!TOKEN){setCarregando(false);return;}
    api("/auth/me").then(d=>setSession(toSession(d.user))).catch(()=>setToken(null)).finally(()=>setCarregando(false));
  },[]);

  // Mescla a lista nova preservando as conversas já baixadas, para não piscar a tela.
  const mesclar=(novos)=>setLeads(ant=>{
    const antes=new Map(ant.map(l=>[l.id,l]));
    return novos.map(l=>adaptLead(l,antes.get(l.id)));
  });

  async function recarregar(){
    if(!session) return;
    try{
      const [ls,eq]=await Promise.all([
        api("/leads"),
        session.role==="corretor"?Promise.resolve(null):api("/distribution/attendants"),
      ]);
      mesclar(ls);
      if(eq) setEquipe(eq);
      if(session.role!=="corretor") setFila((await api("/leads/queue")).map(l=>adaptLead(l)));
      setErro("");
    }catch(e){ setErro(e.message); }
  }

  useEffect(()=>{ if(!session) return; recarregar();
    api("/integracoes").then(d=>setConecta({connected:!!(d.whatsapp&&d.whatsapp.ok),number:d.whatsapp&&d.whatsapp.numero||""})).catch(()=>{});
    const t=setInterval(()=>{ recarregar(); if(selRef.current) abrir(selRef.current,true); },INTERVALO_ATUALIZACAO);
    return ()=>clearInterval(t);
  },[session]);

  // Abre a conversa: baixa as mensagens e marca como lida (o backend ignora a marcação
  // quando é a ADM supervisionando lead de outra pessoa).
  async function abrir(id,silencioso){
    if(!silencioso) setSelId(id);
    try{
      const full=await api(`/leads/${id}`);
      setLeads(ant=>{
        const achou=ant.some(l=>l.id===id);
        const atualizado=ant.map(l=>l.id===id?adaptLead(full,l):l);
        return achou?atualizado:[adaptLead(full),...ant];
      });
      if(!silencioso) api(`/leads/${id}/read`,{method:"POST"}).then(()=>recarregar()).catch(()=>{});
    }catch(e){ if(!silencioso) setErro(e.message); }
  }

  const acao=(fn)=>async(...a)=>{ try{ await fn(...a); await recarregar(); if(selRef.current) await abrir(selRef.current,true); }
                                  catch(e){ setErro(e.message); } };

  const acoes={
    enviar:acao((leadId,text)=>api(`/leads/${leadId}/messages`,{method:"POST",body:{text}})),
    mudarEtapa:acao((leadId,stage)=>api(`/leads/${leadId}/stage`,{method:"PATCH",body:{stage}})),
    registrarVenda:acao((leadId,dados)=>api(`/leads/${leadId}/venda`,{method:"PATCH",body:dados})),
    transferir:acao((leadId,userId)=>api("/distribution/transfer",{method:"POST",body:{lead_id:leadId,user_id:userId}})),
    proximo:acao((leadId)=>api("/distribution/next",{method:"POST",body:{lead_id:leadId}})),
    repassar:acao((leadId,userId)=>api("/distribution/handoff",{method:"POST",body:{lead_id:leadId,...(userId?{user_id:userId}:{})}})),
    disponibilidade:acao((userId,available)=>api("/distribution/availability",{method:"POST",body:{user_id:userId,available}})),
    buscar:(params)=>api("/leads?"+new URLSearchParams(params)).then(r=>r.map(l=>adaptLead(l))),
    relatorio:(params)=>api("/reports?"+new URLSearchParams(params||{})),
    abrir,
  };

  function sair(){ setToken(null); setSession(null); setLeads([]); setFila([]); }

  if(carregando) return <Splash/>;
  if(!session) return <Auth onLogin={(u)=>setSession(toSession(u))}/>;
  return <Workspace {...{session,setSession:sair,equipe,conecta,leads,fila,acoes,selId,setSelId,erro,setErro}}/>;
}

function Splash(){
  return <div style={{fontFamily:FONT,background:C.surface,width:"100%",minHeight:"100dvh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:14}}>
    <Brand/>
    <div style={{color:C.faint,fontSize:13,display:"flex",alignItems:"center",gap:8}}><Icon n="loader" size={15} spin/> Entrando…</div>
  </div>;
}

function Workspace({session,setSession,equipe,conecta,leads,fila,acoes,selId,setSelId,erro,setErro}){
  const role=session.role;
  const canAttend=role==="corretor"||role==="sdr";
  const [view,setView]=useState(role==="adm"?"dashboard":role==="sdr"?"catraca":"atendimento");
  const [tick,setTick]=useState(0);
  const [draft,setDraft]=useState("");
  const [enviando,setEnviando]=useState(false);
  const chatRef=useRef(null);
  const isMobile=useIsMobile();

  // Cores e iniciais da equipe real, derivadas do id — estáveis entre sessões.
  const pessoas=useMemo(()=>equipe.map(u=>({...u,ini:initials(u.name),
    color:COLORS[[...u.id].reduce((a,c)=>a+c.charCodeAt(0),0)%COLORS.length]})),[equipe]);
  const corretores=pessoas.filter(p=>p.role==="corretor");
  const disponiveis=pessoas.filter(p=>p.available);
  const availCorretores=corretores.filter(p=>p.available);
  const euDisponivel=(pessoas.find(p=>p.id===session.id)||{}).available;

  useEffect(()=>{const t=setInterval(()=>setTick(x=>x+1),1000);return()=>clearInterval(t);},[]);
  useEffect(()=>{if(chatRef.current)chatRef.current.scrollTop=chatRef.current.scrollHeight;},[selId,leads]);

  const myLeads=useMemo(()=>leads.filter(l=>l.assignedTo===session.id)
    .sort((a,b)=>{const o={QUENTE:0,MORNO:1,FRIO:2};
      // Quem está esperando resposta sobe na lista, independente da temperatura.
      return (b.unread>0)-(a.unread>0)||o[a.prio]-o[b.prio]||b.createdAt-a.createdAt;}),[leads,session,tick]);
  const sel=leads.find(l=>l.id===selId);

  async function send(){
    if(!draft.trim()||!sel||enviando)return;
    const text=draft.replace("{nome}",first(sel.nome));
    setEnviando(true); setDraft("");
    try{ await acoes.enviar(sel.id,text); }finally{ setEnviando(false); }
  }
  const setStatus=(id,status)=>acoes.mudarEtapa(id,status);
  const openLead=(id)=>{acoes.abrir(id);setView("atendimento");};
  const toggleAvail=(id,estaDisponivel)=>acoes.disponibilidade(id,!estaDisponivel);

  const NAV={
    adm:[["dashboard","grid","Painel"],["conversas","msg","Conversas"],["relatorios","chart","Relatórios"],["conexao","phone2","Conexão"]],
    sdr:[["catraca","transfer","Catraca"],["atendimento","msg","Atender"],["funil","columns","Funil"],["disp","toggleOn","Disponib."],["produtividade","trend","Produção"]],
    corretor:[["atendimento","msg","Atender"],["funil","columns","Funil"],["disp","toggleOn","Disponib."],["produtividade","trend","Produção"]],
  }[role];
  const TITLES={dashboard:"Painel da equipe",conversas:"Conversas da equipe",relatorios:"Relatório por corretor",conexao:"Conexão da Conecta",catraca:"Catraca de distribuição",atendimento:"Atendimento",funil:"Meu funil",disp:"Minha disponibilidade",produtividade:"Minha produtividade"};
  const naoLidas=myLeads.reduce((s,l)=>s+(l.unread>0?1:0),0);

  const roleLabel=role==="adm"?"Administração":role==="sdr"?"SDR":"Corretor(a)";

  return <div style={{fontFamily:FONT,background:C.surface,color:C.ink,width:"100%",height:"100dvh",display:"flex",flexDirection:isMobile?"column":"row",overflow:"hidden"}}>
    {!isMobile&&<aside style={{background:C.greenDeep,width:74,flexShrink:0,display:"flex",flexDirection:"column",alignItems:"center",padding:"20px 0"}}>
      <div style={{background:C.green,width:40,height:40,borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",marginBottom:4}}><Icon n="dot" size={20}/></div>
      <div style={{fontFamily:DISPLAY,color:"#fff",fontSize:10,fontWeight:700,textAlign:"center",lineHeight:1.1,marginBottom:20}}>Con<br/>CRM</div>
      <div style={{display:"flex",flexDirection:"column",gap:4,flex:1}}>
        {NAV.map(([v,n,label])=><button key={v} onClick={()=>setView(v)} title={label} style={{position:"relative",width:52,padding:"8px 0",borderRadius:12,border:"none",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:4,background:view===v?"rgba(255,255,255,.14)":"transparent",color:view===v?"#fff":"rgba(255,255,255,.55)"}}>
          <Icon n={n} size={19}/><span style={{fontSize:9,fontWeight:500}}>{label}</span>
          {v==="atendimento"&&naoLidas>0&&<Badge n={naoLidas} top={4} right={8}/>}
          {v==="catraca"&&fila.length>0&&<Badge n={fila.length} top={4} right={8}/>}
        </button>)}
      </div>
      <button onClick={()=>setSession(null)} title="Sair" style={{width:52,padding:"8px 0",borderRadius:12,border:"none",cursor:"pointer",background:"transparent",color:"rgba(255,255,255,.55)",display:"flex",flexDirection:"column",alignItems:"center",gap:4}}><Icon n="logout" size={18}/><span style={{fontSize:9}}>Sair</span></button>
    </aside>}
    <main style={{flex:1,display:"flex",flexDirection:"column",minWidth:0,minHeight:0}}>
      <header style={{background:C.card,borderBottom:`1px solid ${C.line}`,height:isMobile?52:58,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"space-between",padding:isMobile?"0 14px":"0 20px",gap:12}}>
        <div style={{display:"flex",alignItems:"center",gap:12,minWidth:0}}>
          <h1 style={{fontFamily:DISPLAY,color:C.ink,fontSize:isMobile?15.5:17,fontWeight:700,margin:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{TITLES[view]}</h1>
          {!isMobile&&<span style={{color:conecta.connected?C.greenMid:C.hot,background:conecta.connected?C.greenSoft:C.hotSoft,fontSize:11,fontWeight:600,padding:"3px 9px",borderRadius:999,whiteSpace:"nowrap",flexShrink:0,display:"flex",alignItems:"center",gap:5}}>
            <Icon n={conecta.connected?"wifi":"wifioff"} size={11}/>{conecta.connected?"WhatsApp conectado":"WhatsApp desconectado"}
          </span>}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:isMobile?8:10,flexShrink:0}}>
          {!isMobile&&<div style={{textAlign:"right"}}><div style={{color:C.ink,fontSize:12.5,fontWeight:600,lineHeight:1}}>{session.name}</div><div style={{color:C.faint,fontSize:10.5}}>{roleLabel}</div></div>}
          <Avatar ini={session.ini} color={session.color} size={isMobile?30:34}/>
          {isMobile&&<button onClick={()=>setSession(null)} title="Sair" aria-label="Sair" style={{width:34,height:34,borderRadius:10,border:`1px solid ${C.line}`,background:C.surface,color:C.sub,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon n="logout" size={16}/></button>}
        </div>
      </header>
      {erro&&<div style={{background:C.hotSoft,borderBottom:`1px solid ${C.hot}44`,color:C.hot,fontSize:12.5,padding:"8px 16px",display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
        <Icon n="wifioff" size={14}/><span style={{flex:1}}>{erro}</span>
        <button onClick={()=>setErro("")} style={{border:"none",background:"transparent",color:C.hot,cursor:"pointer",fontWeight:700}}>×</button>
      </div>}
      <div style={{flex:1,minHeight:0}}>
        {canAttend&&view==="atendimento"&&<Atendimento {...{myLeads,sel,abrir:acoes.abrir,draft,setDraft,send,enviando,setStatus,chatRef,conecta,session,acoes,canHandoff:role==="sdr",availCorretores,isMobile}}/>}
        {canAttend&&view==="funil"&&<Funil leads={myLeads} openLead={openLead} setStatus={setStatus} isMobile={isMobile}/>}
        {canAttend&&view==="disp"&&<Disponibilidade avail={euDisponivel} toggle={()=>toggleAvail(session.id,euDisponivel)} name={session.name}/>}
        {canAttend&&view==="produtividade"&&<Relatorios acoes={acoes} session={session} isMobile={isMobile}/>}
        {role==="sdr"&&view==="catraca"&&<Catraca {...{fila,pessoas,disponiveis,toggleAvail,acoes,isMobile}}/>}
        {role==="adm"&&view==="dashboard"&&<Dashboard {...{acoes,pessoas,fila,setView,isMobile}}/>}
        {role==="adm"&&view==="conversas"&&<Conversas {...{acoes,pessoas,sel,session,chatRef,isMobile}}/>}
        {role==="adm"&&view==="relatorios"&&<Relatorios acoes={acoes} session={session} pickable isMobile={isMobile}/>}
        {role==="adm"&&view==="conexao"&&<Conexao conecta={conecta}/>}
      </div>
    </main>
    {isMobile&&<nav style={{background:C.greenDeep,flexShrink:0,display:"flex",alignItems:"stretch",justifyContent:"space-around",paddingBottom:"env(safe-area-inset-bottom)"}}>
      {NAV.map(([v,n,label])=><button key={v} onClick={()=>setView(v)} style={{position:"relative",flex:1,minWidth:0,padding:"9px 2px 10px",border:"none",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:3,background:"transparent",color:view===v?"#fff":"rgba(255,255,255,.5)",borderTop:`2px solid ${view===v?C.green:"transparent"}`}}>
        <Icon n={n} size={20}/><span style={{fontSize:9.5,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"100%"}}>{label}</span>
        {v==="atendimento"&&naoLidas>0&&<Badge n={naoLidas} top={4} right={"22%"}/>}
        {v==="catraca"&&fila.length>0&&<Badge n={fila.length} top={4} right={"22%"}/>}
      </button>)}
    </nav>}
  </div>;
}

function Badge({n,top,right}){
  return <span style={{position:"absolute",top,right,minWidth:16,height:16,padding:"0 4px",borderRadius:999,background:C.hot,color:"#fff",fontSize:10,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1}}>{n>9?"9+":n}</span>;
}

/* ===== item da lista de leads =====
   Não lida em destaque: nome em negrito, fundo levemente verde e contador.
   É o sinal de "o cliente está esperando" que o Ali pediu. */
function ItemLead({l,ativo,onClick,isMobile,mostrarDono}){
  const naoLida=l.unread>0, espera=Date.now()-(l.lastAt||l.createdAt);
  return <button onClick={onClick} style={{width:"100%",textAlign:"left",padding:isMobile?"13px 14px":"10px 12px",borderBottom:`1px solid ${C.line}`,borderLeft:`3px solid ${ativo?C.green:naoLida?C.hot:"transparent"}`,background:ativo?C.greenSoft:naoLida?"#FFFBFA":"transparent",border:"none",cursor:"pointer",display:"flex",flexDirection:"column",gap:4}}>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
      <span style={{color:C.ink,fontSize:13.5,fontWeight:naoLida?700:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.nome}</span>
      <div style={{display:"flex",alignItems:"center",gap:5,flexShrink:0}}>
        {naoLida&&<span style={{minWidth:18,height:18,padding:"0 5px",borderRadius:999,background:C.hot,color:"#fff",fontSize:10.5,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center"}}>{l.unread}</span>}
        <Pill c={PRIO[l.prio].c} bg={PRIO[l.prio].bg}>{PRIO[l.prio].label}</Pill>
      </div>
    </div>
    <span style={{color:naoLida?C.ink:C.faint,fontWeight:naoLida?500:400,fontSize:11.5,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
      {l.lastBody?(l.lastDirection==="in"?"":"Você: ")+l.lastBody:"Novo lead — sem contato"}
    </span>
    <div style={{display:"flex",alignItems:"center",gap:6,marginTop:2,flexWrap:"wrap"}}>
      {naoLida
        ?<span style={{display:"flex",alignItems:"center",gap:4,color:ageColor(espera),fontFamily:MONO,fontSize:11,fontWeight:600}}><Icon n="timer" size={12} color={ageColor(espera)}/>aguardando há {fmtAge(espera)}</span>
        :<span style={{color:STAGE_C[l.status],background:STAGE_C[l.status]+"16",fontSize:10,fontWeight:600,padding:"1px 6px",borderRadius:4}}>{l.status}</span>}
      {mostrarDono&&<span style={{color:C.faint,fontSize:10.5}}>{l.assignedName||"na fila"}</span>}
    </div>
  </button>;
}

/* ===== ATENDIMENTO ===== */
function Atendimento({myLeads,sel,abrir,draft,setDraft,send,enviando,setStatus,chatRef,conecta,session,acoes,canHandoff,availCorretores,isMobile}){
  const [filter,setFilter]=useState("Todos");
  // No celular só cabe um painel por vez: lista → conversa → ficha.
  const [pane,setPane]=useState(()=>sel?"chat":"lista");
  const isCompact=useIsCompact();
  const fichaPorBotao=isMobile||isCompact; // ficha não cabe fixa ao lado
  const list=myLeads.filter(l=>filter==="Todos"?true:filter==="Aguardando"?l.unread>0:l.prio===filter.toUpperCase());
  const openChat=(id)=>{abrir(id);setPane("chat");};
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
        {list.map(l=><ItemLead key={l.id} l={l} ativo={!isMobile&&sel&&sel.id===l.id} onClick={()=>openChat(l.id)} isMobile={isMobile}/>)}
      </div>
    </div>}
    {showChat&&<div style={{flex:1,display:"flex",flexDirection:"column",minWidth:0,minHeight:0,background:C.surface}}>
      <div style={{background:C.card,borderBottom:`1px solid ${C.line}`,height:56,display:"flex",alignItems:"center",justifyContent:"space-between",padding:isMobile?"0 10px":"0 16px",gap:8,flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:isMobile?8:12,minWidth:0}}>
          {isMobile&&backBtn(()=>setPane("lista"),"Voltar para a lista")}
          <Avatar ini={initials(sel.nome)} color={PRIO[sel.prio].c} size={36}/>
          <div style={{minWidth:0}}><div style={{color:C.ink,fontSize:14,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{sel.nome}</div><div style={{color:C.faint,fontSize:11.5,display:"flex",alignItems:"center",gap:4}}><Icon n="phone" size={11}/>{fmtTel(sel.tel)}</div></div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:7,flexShrink:0}}>
          <BotaoLigar tel={sel.tel} compacto={isMobile}/>
          {fichaPorBotao
            ?<button onClick={()=>setPane("ficha")} style={{display:"flex",alignItems:"center",gap:5,border:`1px solid ${C.line}`,background:C.surface,color:C.sub,fontSize:12,fontWeight:600,padding:"7px 12px",borderRadius:10,cursor:"pointer"}}><Icon n="star" size={13} color={PRIO[sel.prio].c} fill={PRIO[sel.prio].c}/> Ficha</button>
            :<div style={{color:conecta.connected?C.green:C.faint,background:conecta.connected?C.greenSoft:C.coolSoft,fontSize:11,fontWeight:600,padding:"4px 10px",borderRadius:999,display:"flex",alignItems:"center",gap:4}}><Icon n={conecta.connected?"wifi":"wifioff"} size={12}/>Número da Conecta</div>}
        </div>
      </div>
      <div ref={chatRef} style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",padding:isMobile?"14px 12px":"16px 20px",display:"flex",flexDirection:"column",gap:8,minHeight:0}}>
        {sel.msgs.length===0&&<div style={{color:C.faint,margin:"auto",textAlign:"center",maxWidth:280}}><Icon n="spark" size={22} color={C.green}/><div style={{fontSize:13,marginTop:8}}>Lead ainda não contatado.<br/>Use um modelo e fale agora — quanto mais rápido, maior a chance.</div></div>}
        {sel.msgs.map((m,i)=>{
          if(m.from==="system")return <div key={i} style={{alignSelf:"center",background:C.amberSoft,color:"#8a6d1f",fontSize:11,fontWeight:600,padding:"3px 10px",borderRadius:999,margin:"2px 0"}}>{m.text}</div>;
          const mine=m.from==="corretor";const senderName=m.byName||first(session.name);
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
          <button onClick={send} disabled={enviando||!draft.trim()} style={{width:44,height:44,borderRadius:12,border:"none",cursor:enviando?"default":"pointer",background:enviando||!draft.trim()?C.faint:C.green,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon n={enviando?"loader":"send"} size={18} spin={enviando}/></button>
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
          <button onClick={()=>acoes.repassar(sel.id)} disabled={!availCorretores.length} style={{width:"100%",background:availCorretores.length?C.green:C.coolSoft,color:availCorretores.length?"#fff":C.faint,border:"none",cursor:availCorretores.length?"pointer":"default",fontSize:12.5,fontWeight:600,padding:"9px",borderRadius:9,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}><Icon n="transfer" size={14}/> Passar para o corretor da vez</button>
          <div style={{color:C.faint,fontSize:10.5,margin:"8px 0 5px"}}>ou escolher um corretor:</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
            {availCorretores.length?availCorretores.map(b=><button key={b.id} onClick={()=>acoes.repassar(sel.id,b.id)} title={b.name} style={{display:"flex",alignItems:"center",gap:5,border:`1px solid ${C.line}`,background:C.card,borderRadius:999,padding:"3px 9px 3px 3px",cursor:"pointer"}}><Avatar ini={b.ini} color={b.color} size={20}/><span style={{color:C.ink,fontSize:11.5,fontWeight:500}}>{first(b.name)}</span></button>):<span style={{color:C.hot,fontSize:11}}>Nenhum corretor disponível agora.</span>}
          </div>
        </div>}
        <label style={{color:C.faint,fontSize:10.5,fontWeight:600,textTransform:"uppercase",letterSpacing:.5}}>Etapa do funil</label>
        <select value={sel.status} onChange={e=>setStatus(sel.id,e.target.value)} style={{width:"100%",marginTop:4,marginBottom:8,fontSize:isMobile?16:13,fontWeight:600,borderRadius:8,border:`1px solid ${C.line}`,padding:"8px 10px",outline:"none",color:STAGE_C[sel.status],background:C.surface}}>{STAGES.map(s=><option key={s} value={s}>{s}</option>)}</select>
        <div style={{color:C.faint,fontSize:10.5,marginBottom:12,lineHeight:1.4}}>A etapa avança sozinha conforme a conversa. Você pode ajustar manualmente aqui.</div>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {[["Renda familiar",sel.qual.renda,"target"],["Entrada",sel.qual.entrada,"check"],["Situação",sel.qual.situacao,"users"],["Restrição CPF",sel.qual.cpf,"award"],["Prazo p/ comprar",sel.qual.prazo,"calendar"]].map(([k,v,n])=><div key={k}><div style={{color:C.faint,fontSize:10.5,fontWeight:600,display:"flex",alignItems:"center",gap:4,marginBottom:2}}><Icon n={n} size={11}/>{k}</div><div style={{color:C.ink,fontSize:12.5,fontWeight:500}}>{v}</div></div>)}
        </div>
        <FichaVenda lead={sel} onSalvar={(d)=>acoes.registrarVenda(sel.id,d)}/>
        <div style={{borderTop:`1px solid ${C.line}`,marginTop:16,paddingTop:12,display:"flex",flexDirection:"column",gap:6}}>
          <div style={{color:C.sub,fontSize:11.5,display:"flex",alignItems:"center",gap:6}}><Icon n="mail" size={12} color={C.faint}/> via {sel.origem}</div>
          <div style={{color:C.sub,fontSize:11.5,display:"flex",alignItems:"center",gap:6}}><Icon n="clock" size={12} color={C.faint}/> entrou há {fmtAge(Date.now()-sel.createdAt)}</div>
        </div>
      </div>
    </div>}
  </div>;
}

/* ===== REGISTRO DE VENDA (pedido do Ali: valor, data e qual imóvel) ===== */
function FichaVenda({lead,onSalvar}){
  const v=lead.venda;
  const [aberto,setAberto]=useState(false);
  const [f,setF]=useState({valor:"",data:new Date().toISOString().slice(0,10),imovel:""});
  const [erro,setErro]=useState("");
  useEffect(()=>{ setAberto(false); setErro("");
    setF({valor:v?String(v.valor):"",data:v&&v.data?new Date(v.data).toISOString().slice(0,10):new Date().toISOString().slice(0,10),imovel:v&&v.imovel||""});
  },[lead.id]);

  async function salvar(){
    const valor=Number(String(f.valor).replace(/\./g,"").replace(",","."));
    if(!isFinite(valor)||valor<=0) return setErro("Informe o valor da venda.");
    setErro(""); await onSalvar({valor,data:f.data,imovel:f.imovel}); setAberto(false);
  }

  if(v&&!aberto) return <div style={{background:C.greenSoft,border:`1px solid ${C.green}33`,borderRadius:12,padding:12,marginTop:14}}>
    <div style={{color:C.greenDeep,fontSize:11.5,fontWeight:700,display:"flex",alignItems:"center",gap:5,marginBottom:8}}><Icon n="check" size={13} color={C.greenMid}/> Venda registrada</div>
    <div style={{color:C.greenDeep,fontFamily:MONO,fontSize:19,fontWeight:700}}>{fmtMoeda(v.valor)}</div>
    <div style={{color:C.sub,fontSize:11.5,marginTop:4}}>{v.imovel||"Imóvel não informado"} · {fmtData(v.data)}</div>
    <button onClick={()=>setAberto(true)} style={{marginTop:8,border:"none",background:"transparent",color:C.greenMid,fontSize:11.5,fontWeight:600,cursor:"pointer",padding:0}}>Editar registro</button>
  </div>;

  if(!aberto) return <button onClick={()=>setAberto(true)} style={{width:"100%",marginTop:14,display:"flex",alignItems:"center",justifyContent:"center",gap:6,border:`1px dashed ${C.green}66`,background:C.greenSoft,color:C.greenMid,fontSize:12.5,fontWeight:600,padding:"10px",borderRadius:12,cursor:"pointer"}}><Icon n="award" size={14}/> Registrar venda</button>;

  return <div style={{background:C.card,border:`1px solid ${C.green}55`,borderRadius:12,padding:12,marginTop:14}}>
    <div style={{color:C.ink,fontSize:12,fontWeight:700,marginBottom:8}}>Registrar venda</div>
    <label style={{color:C.faint,fontSize:10.5,fontWeight:600}}>Valor do imóvel</label>
    <input value={f.valor} onChange={e=>setF({...f,valor:e.target.value})} inputMode="decimal" placeholder="285000"
      style={{width:"100%",margin:"3px 0 8px",fontSize:16,border:`1px solid ${C.line}`,borderRadius:8,padding:"8px 10px",outline:"none",background:C.surface,color:C.ink}}/>
    <label style={{color:C.faint,fontSize:10.5,fontWeight:600}}>Data da venda</label>
    <input type="date" value={f.data} onChange={e=>setF({...f,data:e.target.value})}
      style={{width:"100%",margin:"3px 0 8px",fontSize:16,border:`1px solid ${C.line}`,borderRadius:8,padding:"8px 10px",outline:"none",background:C.surface,color:C.ink}}/>
    <label style={{color:C.faint,fontSize:10.5,fontWeight:600}}>Qual imóvel</label>
    <input value={f.imovel} onChange={e=>setF({...f,imovel:e.target.value})} placeholder="Ex.: Jardim Amazonas — Casa 14"
      style={{width:"100%",margin:"3px 0 8px",fontSize:16,border:`1px solid ${C.line}`,borderRadius:8,padding:"8px 10px",outline:"none",background:C.surface,color:C.ink}}/>
    {erro&&<div style={{color:C.hot,fontSize:11.5,marginBottom:8}}>{erro}</div>}
    <div style={{display:"flex",gap:6}}>
      <button onClick={salvar} style={{flex:1,background:C.green,color:"#fff",border:"none",borderRadius:9,padding:"9px",fontSize:12.5,fontWeight:600,cursor:"pointer"}}>Salvar</button>
      <button onClick={()=>setAberto(false)} style={{border:`1px solid ${C.line}`,background:C.card,color:C.sub,borderRadius:9,padding:"9px 12px",fontSize:12.5,cursor:"pointer"}}>Cancelar</button>
    </div>
    <div style={{color:C.faint,fontSize:10.5,marginTop:7,lineHeight:1.4}}>Ao salvar, o lead vai para a etapa <b>Venda</b> e entra no seu relatório.</div>
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
function Catraca({fila,pessoas,disponiveis,toggleAvail,acoes,isMobile}){
  const novos=[...fila].sort((a,b)=>({QUENTE:0,MORNO:1,FRIO:2}[a.prio]-{QUENTE:0,MORNO:1,FRIO:2}[b.prio]));
  const brokers=pessoas, disp=disponiveis;
  const transfer=(leadId,uid)=>acoes.transferir(leadId,uid);
  const catracaNext=(leadId)=>acoes.proximo(leadId);
  return <div style={{height:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch",padding:isMobile?14:20}}>
    <div style={{maxWidth:860,margin:"0 auto"}}>
      {/* roster de disponibilidade */}
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16,marginBottom:16}}>
        <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:10,display:"flex",alignItems:"center",gap:8}}><Icon n="users" size={15} color={C.green}/> Disponíveis hoje ({disp.length}/{brokers.length})</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {brokers.length===0&&<span style={{color:C.faint,fontSize:12}}>Ninguém cadastrado ainda — mande o link de cadastro para a equipe.</span>}
          {brokers.map(b=>{const on=b.available;return <button key={b.id} onClick={()=>toggleAvail(b.id,on)} style={{display:"flex",alignItems:"center",gap:8,border:`1px solid ${on?C.green:C.line}`,background:on?C.greenSoft:C.card,borderRadius:999,padding:"5px 12px 5px 5px",cursor:"pointer"}}>
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
              <div style={{minWidth:0,flex:1}}><div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}><span style={{color:C.ink,fontSize:13.5,fontWeight:600}}>{l.nome}</span><Pill c={PRIO[l.prio].c} bg={PRIO[l.prio].bg}>{PRIO[l.prio].label}</Pill></div><div style={{color:C.faint,fontSize:11.5,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{fmtTel(l.tel)} · {l.lastBody||"sem mensagem"}</div></div>
              <div style={{display:"flex",alignItems:"center",gap:4,marginRight:4,flexShrink:0}}><Icon n="timer" size={13} color={ageColor(age)}/><span style={{color:ageColor(age),fontFamily:MONO,fontSize:12,fontWeight:600}}>{fmtAge(age)}</span></div>
              {/* no celular o botão desce para a linha de baixo, em largura total */}
              {!isMobile&&<button onClick={()=>catracaNext(l.id)} disabled={!disp.length} style={{background:disp.length?C.greenDeep:C.coolSoft,color:disp.length?"#fff":C.faint,border:"none",cursor:disp.length?"pointer":"default",fontSize:12,fontWeight:600,padding:"8px 12px",borderRadius:10,display:"flex",alignItems:"center",gap:6,whiteSpace:"nowrap"}}><Icon n="transfer" size={14}/> Próximo</button>}
            </div>
            {isMobile&&<button onClick={()=>catracaNext(l.id)} disabled={!disp.length} style={{width:"100%",marginTop:10,background:disp.length?C.greenDeep:C.coolSoft,color:disp.length?"#fff":C.faint,border:"none",cursor:disp.length?"pointer":"default",fontSize:13,fontWeight:600,padding:"11px",borderRadius:10,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}><Icon n="transfer" size={14}/> Passar para o próximo</button>}
            <div style={{display:"flex",alignItems:"center",gap:6,marginTop:10,paddingTop:10,borderTop:`1px solid ${C.line}`,flexWrap:"wrap"}}>
              <span style={{color:C.faint,fontSize:11,fontWeight:600}}>Transferir para:</span>
              {disp.length?disp.map(b=><button key={b.id} onClick={()=>transfer(l.id,b.id)} title={b.name} style={{display:"flex",alignItems:"center",gap:6,border:`1px solid ${C.line}`,background:C.surface,borderRadius:999,padding:"3px 10px 3px 3px",cursor:"pointer"}}><Avatar ini={b.ini} color={b.color} size={22}/><span style={{color:C.ink,fontSize:12,fontWeight:500}}>{first(b.name)}</span></button>):<span style={{color:C.hot,fontSize:11.5}}>Ninguém disponível — marque um atendente acima.</span>}
            </div>
          </div>;})}
      </div>
    </div>
  </div>;
}

/* ===== CONVERSAS (ADM) =====
   Acesso irrestrito: a ADM abre a conversa de qualquer corretor, com filtros
   para analisar atendimento por atendimento. Somente leitura — supervisionar
   não marca a conversa como lida, para não apagar o aviso do corretor. */
function Conversas({acoes,pessoas,sel,session,chatRef,isMobile}){
  const [f,setF]=useState({atendente:"",etapa:"",prioridade:"",q:""});
  const [lista,setLista]=useState([]);
  const [carregando,setCarregando]=useState(true);
  const [pane,setPane]=useState("lista");
  const [busca,setBusca]=useState("");

  useEffect(()=>{const t=setTimeout(()=>setF(p=>({...p,q:busca})),350);return()=>clearTimeout(t);},[busca]);
  useEffect(()=>{
    let vivo=true; setCarregando(true);
    const params={}; Object.entries(f).forEach(([k,v])=>{if(v)params[k]=v;});
    acoes.buscar(params).then(r=>{if(vivo){setLista(r);setCarregando(false);}}).catch(()=>vivo&&setCarregando(false));
    return()=>{vivo=false;};
  },[f.atendente,f.etapa,f.prioridade,f.q]);

  const abrir=(id)=>{acoes.abrir(id);setPane("chat");};
  const mostrarLista=!isMobile||pane==="lista";
  const mostrarChat=sel&&(!isMobile||pane==="chat");
  const selo=(label,valor,campo,opcoes)=><select value={valor} onChange={e=>setF({...f,[campo]:e.target.value})}
    style={{fontSize:isMobile?16:12.5,fontWeight:500,color:valor?C.ink:C.sub,background:valor?C.greenSoft:C.surface,border:`1px solid ${valor?C.green+"66":C.line}`,borderRadius:9,padding:"7px 10px",outline:"none",maxWidth:"100%"}}>
    <option value="">{label}</option>
    {opcoes.map(o=><option key={o.v} value={o.v}>{o.t}</option>)}
  </select>;

  return <div style={{height:"100%",display:"flex",minHeight:0}}>
    {mostrarLista&&<div style={{width:isMobile?"100%":340,flexShrink:0,borderRight:isMobile?"none":`1px solid ${C.line}`,background:C.card,display:"flex",flexDirection:"column",minHeight:0}}>
      <div style={{padding:12,borderBottom:`1px solid ${C.line}`,display:"flex",flexDirection:"column",gap:8}}>
        <div style={{display:"flex",alignItems:"center",gap:8,border:`1px solid ${C.line}`,background:C.surface,borderRadius:10,padding:"0 10px"}}>
          <Icon n="search" size={15} color={C.faint}/>
          <input value={busca} onChange={e=>setBusca(e.target.value)} placeholder="Buscar por nome ou telefone"
            style={{flex:1,border:"none",outline:"none",background:"transparent",fontSize:isMobile?16:13,padding:"9px 0",color:C.ink,minWidth:0}}/>
        </div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {selo("Todo mundo",f.atendente,"atendente",[{v:"fila",t:"Na fila (sem dono)"},...pessoas.map(p=>({v:p.id,t:p.name}))])}
          {selo("Etapa",f.etapa,"etapa",STAGES.map(s=>({v:s,t:s})))}
          {selo("Prioridade",f.prioridade,"prioridade",[{v:"QUENTE",t:"Quente"},{v:"MORNO",t:"Morno"},{v:"FRIO",t:"Frio"}])}
        </div>
        <div style={{color:C.faint,fontSize:11}}>{carregando?"Buscando…":`${lista.length} conversa(s)`}</div>
      </div>
      <div style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
        {!carregando&&lista.length===0&&<div style={{color:C.faint,fontSize:13,textAlign:"center",padding:32}}>Nada encontrado com esses filtros.</div>}
        {lista.map(l=><ItemLead key={l.id} l={l} ativo={!isMobile&&sel&&sel.id===l.id} onClick={()=>abrir(l.id)} isMobile={isMobile} mostrarDono/>)}
      </div>
    </div>}

    {mostrarChat?<div style={{flex:1,display:"flex",flexDirection:"column",minWidth:0,minHeight:0,background:C.surface}}>
      <div style={{background:C.card,borderBottom:`1px solid ${C.line}`,padding:"10px 14px",display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
        {isMobile&&<button onClick={()=>setPane("lista")} aria-label="Voltar" style={{width:34,height:34,borderRadius:10,border:"none",background:C.surface,color:C.sub,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",transform:"scaleX(-1)",flexShrink:0}}><Icon n="chevron" size={17}/></button>}
        <Avatar ini={initials(sel.nome)} color={PRIO[sel.prio].c} size={36}/>
        <div style={{minWidth:0,flex:1}}>
          <div style={{color:C.ink,fontSize:14,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{sel.nome}</div>
          <div style={{color:C.faint,fontSize:11.5}}>{fmtTel(sel.tel)} · {sel.assignedName?"com "+first(sel.assignedName):"na fila"}</div>
        </div>
        <BotaoLigar tel={sel.tel} compacto/>
      </div>
      <div style={{background:C.amberSoft,color:"#8a6d1f",fontSize:11.5,padding:"6px 14px",display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
        <Icon n="lock" size={12}/> Modo supervisão — somente leitura. Abrir aqui não marca a conversa como lida para o corretor.
      </div>
      <div ref={chatRef} style={{flex:1,overflowY:"auto",WebkitOverflowScrolling:"touch",padding:isMobile?"14px 12px":"16px 20px",display:"flex",flexDirection:"column",gap:8,minHeight:0}}>
        {sel.msgs.length===0&&<div style={{color:C.faint,margin:"auto",fontSize:13}}>Nenhuma mensagem trocada ainda.</div>}
        {sel.msgs.map((m,i)=>{
          const meu=m.from==="corretor";
          return <div key={i} style={{display:"flex",justifyContent:meu?"flex-end":"flex-start"}}>
            <div style={{maxWidth:isMobile?"86%":"74%",padding:"8px 12px",fontSize:13.5,lineHeight:1.35,borderRadius:16,background:meu?C.green:C.card,color:meu?"#fff":C.ink,border:meu?"none":`1px solid ${C.line}`,borderBottomRightRadius:meu?4:16,borderBottomLeftRadius:meu?16:4}}>
              {meu&&<div style={{fontSize:10.5,fontWeight:700,color:"rgba(255,255,255,.85)",marginBottom:2}}>{m.byName||"Conecta"}</div>}
              {m.text}<div style={{color:meu?"rgba(255,255,255,.7)":C.faint,fontSize:10,marginTop:2,textAlign:"right"}}>{fmtClock(m.at)}</div>
            </div>
          </div>;})}
      </div>
      <div style={{background:C.card,borderTop:`1px solid ${C.line}`,padding:"10px 14px",display:"flex",gap:14,flexWrap:"wrap",flexShrink:0}}>
        {[["Etapa",sel.status],["Entrou há",fmtAge(Date.now()-sel.createdAt)],["Origem",sel.origem],
          ["Venda",sel.venda?fmtMoeda(sel.venda.valor):"—"]].map(([k,v])=>
          <div key={k}><div style={{color:C.faint,fontSize:10,fontWeight:600,textTransform:"uppercase",letterSpacing:.4}}>{k}</div><div style={{color:C.ink,fontSize:12.5,fontWeight:600}}>{v}</div></div>)}
      </div>
    </div>:(!isMobile&&<div style={{flex:1,background:C.surface,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{color:C.faint,textAlign:"center",maxWidth:280}}><Icon n="msg" size={26} color={C.faint}/><div style={{fontSize:13,marginTop:10,lineHeight:1.5}}>Escolha uma conversa à esquerda para acompanhar o atendimento.</div></div>
    </div>)}
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
function Conexao({conecta}){
  const isMobile=useIsMobile();
  return <div style={{height:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch",padding:isMobile?14:24}}>
    <div style={{maxWidth:560,margin:"0 auto"}}>
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:24,textAlign:"center"}}>
        <div style={{background:conecta.connected?C.greenSoft:C.hotSoft,width:64,height:64,borderRadius:16,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px",color:conecta.connected?C.green:C.hot}}><Icon n={conecta.connected?"wifi":"wifioff"} size={28}/></div>
        <div style={{color:C.ink,fontFamily:DISPLAY,fontSize:18,fontWeight:700}}>{conecta.connected?"WhatsApp da Conecta conectado":"WhatsApp desconectado"}</div>
        {conecta.connected?<React.Fragment>
          <div style={{color:C.sub,fontSize:13,marginTop:4}}>Todos os corretores atendem por este número:</div>
          <div style={{color:C.green,fontFamily:MONO,fontSize:16,fontWeight:600,margin:"8px 0"}}>{fmtTel(conecta.number)}</div>
          <Pill c={C.greenMid} bg={C.greenSoft}>Ativo via Uazapi</Pill>
        </React.Fragment>:<div style={{color:C.sub,fontSize:13,margin:"6px 0 0",lineHeight:1.6}}>
          O CRM não está conseguindo falar com a Uazapi. Confira no painel da Uazapi se a instância
          está <b>connected</b>, e na hospedagem se <b>UAZAPI_HOST</b> e <b>UAZAPI_TOKEN</b> continuam preenchidos.
        </div>}
        {/* A conexão em si é feita no painel da Uazapi (QR / pareamento). Aqui só espelhamos o estado real —
            botão de "conectar" aqui daria a falsa impressão de que o CRM controla o pareamento. */}
      </div>
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:20,marginTop:16}}>
        <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:8,display:"flex",alignItems:"center",gap:8}}><Icon n="link" size={15} color={C.green}/> Como funciona</div>
        <div style={{color:C.sub,fontSize:12.5,lineHeight:1.6}}>Um único número da Conecta conectado via Uazapi. Todos os corretores atendem por ele, e cada mensagem sai assinada com o nome de quem enviou — o lead sempre sabe com quem está falando.</div>
      </div>
    </div>
  </div>;
}

/* ===== RELATÓRIOS (dados reais, com filtro de período) ===== */
const hojeISO=()=>new Date().toISOString().slice(0,10);
const diasAtras=(n)=>new Date(Date.now()-n*86400000).toISOString().slice(0,10);

function Relatorios({acoes,session,pickable,isMobile}){
  const [periodo,setPeriodo]=useState({de:diasAtras(30),ate:hojeISO()});
  const [dados,setDados]=useState(null);
  const [carregando,setCarregando]=useState(true);
  const [sel,setSel]=useState(null);

  useEffect(()=>{
    let vivo=true; setCarregando(true);
    acoes.relatorio(periodo).then(d=>{if(vivo){setDados(d);setCarregando(false);
      setSel(p=>p&&d.atendentes.some(a=>a.id===p)?p:(d.atendentes[0]||{}).id);}}).catch(()=>vivo&&setCarregando(false));
    return()=>{vivo=false;};
  },[periodo.de,periodo.ate]);

  const atalho=(label,dias)=><button key={label} onClick={()=>setPeriodo({de:diasAtras(dias),ate:hojeISO()})}
    style={{fontSize:12,fontWeight:600,padding:"6px 11px",borderRadius:999,border:"none",cursor:"pointer",
      background:periodo.de===diasAtras(dias)?C.greenDeep:C.surface,color:periodo.de===diasAtras(dias)?"#fff":C.sub}}>{label}</button>;

  if(carregando&&!dados) return <div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:C.faint,fontSize:13,gap:8}}><Icon n="loader" size={16} spin/> Calculando…</div>;
  if(!dados) return <div style={{padding:24,color:C.faint}}>Não consegui carregar o relatório.</div>;

  const linha=dados.atendentes.find(a=>a.id===sel)||dados.atendentes[0];

  return <div style={{height:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch",padding:isMobile?14:20}}>
    <div style={{maxWidth:920,margin:"0 auto"}}>
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:14,marginBottom:16}}>
        <div style={{display:"flex",gap:7,flexWrap:"wrap",marginBottom:10}}>
          {atalho("7 dias",7)}{atalho("30 dias",30)}{atalho("90 dias",90)}
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <span style={{color:C.faint,fontSize:11.5,fontWeight:600}}>De</span>
          <input type="date" value={periodo.de} onChange={e=>setPeriodo({...periodo,de:e.target.value})} style={{fontSize:isMobile?16:12.5,border:`1px solid ${C.line}`,borderRadius:8,padding:"6px 8px",background:C.surface,color:C.ink,outline:"none"}}/>
          <span style={{color:C.faint,fontSize:11.5,fontWeight:600}}>até</span>
          <input type="date" value={periodo.ate} onChange={e=>setPeriodo({...periodo,ate:e.target.value})} style={{fontSize:isMobile?16:12.5,border:`1px solid ${C.line}`,borderRadius:8,padding:"6px 8px",background:C.surface,color:C.ink,outline:"none"}}/>
        </div>
      </div>

      <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:16}}>
        <Metric n="users" label="Leads no período" value={dados.total.leads} accent={C.cool}/>
        <Metric n="transfer" label="Ainda na fila" value={dados.total.na_fila} accent={dados.total.na_fila?C.hot:C.green}/>
        <Metric n="check" label="Vendas" value={dados.total.vendas} accent={C.greenDeep}/>
        <Metric n="award" label="Valor vendido" value={fmtMoeda(dados.total.valor_vendido)} accent={C.green}/>
      </div>

      {pickable&&dados.atendentes.length>0&&<div style={{display:"flex",gap:8,marginBottom:16,overflowX:"auto",paddingBottom:4}}>
        {dados.atendentes.map(a=><button key={a.id} onClick={()=>setSel(a.id)} style={{flexShrink:0,display:"flex",alignItems:"center",gap:8,border:`1px solid ${sel===a.id?C.green:C.line}`,background:sel===a.id?C.greenSoft:C.card,borderRadius:999,padding:"4px 12px 4px 4px",cursor:"pointer"}}>
          <Avatar ini={initials(a.nome)} color={COLORS[[...a.id].reduce((s,c)=>s+c.charCodeAt(0),0)%COLORS.length]} size={26}/>
          <span style={{color:C.ink,fontSize:13,fontWeight:500}}>{first(a.nome)}</span></button>)}
      </div>}

      {!linha?<div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:32,textAlign:"center",color:C.faint,fontSize:13}}>Nenhum atendente cadastrado ainda.</div>
      :<React.Fragment>
        <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16,marginBottom:16,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
          <Avatar ini={initials(linha.nome)} color={COLORS[[...linha.id].reduce((s,c)=>s+c.charCodeAt(0),0)%COLORS.length]} size={46}/>
          <div style={{minWidth:0}}>
            <div style={{color:C.ink,fontFamily:DISPLAY,fontSize:isMobile?16:18,fontWeight:700}}>{linha.nome}</div>
            <div style={{color:C.faint,fontSize:12}}>{linha.papel==="sdr"?"SDR":"Corretor(a)"} · {fmtData(dados.periodo.de)} a {fmtData(dados.periodo.ate)}</div>
          </div>
          <div style={{marginLeft:"auto",textAlign:"right"}}>
            <div style={{color:linha.primeira_resposta_mediana_min<=10?C.green:linha.primeira_resposta_mediana_min<=30?C.amber:C.hot,fontFamily:MONO,fontSize:isMobile?26:30,fontWeight:600,lineHeight:1}}>{linha.primeira_resposta_mediana_min}<span style={{fontSize:15}}> min</span></div>
            <div style={{color:C.faint,fontSize:11,marginTop:4}}>1ª resposta (mediana)</div>
          </div>
        </div>

        <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:16}}>
          <Metric n="users" label="Recebidos" value={linha.recebidos} accent={C.cool}/>
          <Metric n="msg" label="Atendidos" value={linha.atendidos} sub={linha.taxa_atendimento+"% de resposta"} accent={C.green}/>
          <Metric n="calendar" label="Agendados / visitas" value={linha.agendamentos} accent="#3B7BC4"/>
          <Metric n="check" label="Vendas" value={linha.vendas} sub={fmtMoeda(linha.valor_vendido)} accent={C.greenDeep}/>
        </div>

        <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16}}>
          <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:12}}>Avanço pelas etapas do funil</div>
          {STAGES.map(st=>{const v=linha.por_etapa[st]||0,pct=linha.recebidos?v/linha.recebidos*100:0;
            return <div key={st} style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
              <span style={{color:C.sub,fontSize:11.5,width:isMobile?104:150,flexShrink:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{st}</span>
              <div style={{height:10,borderRadius:999,background:C.surface,flex:1,overflow:"hidden"}}><div style={{width:Math.max(pct,v?6:0)+"%",height:"100%",borderRadius:999,background:STAGE_C[st]}}/></div>
              <span style={{color:C.ink,fontFamily:MONO,fontSize:12,fontWeight:600,width:20,textAlign:"right"}}>{v}</span>
            </div>;})}
        </div>
      </React.Fragment>}
    </div>
  </div>;
}

/* ===== DASHBOARD (ADM) ===== */
function Dashboard({acoes,pessoas,fila,setView,isMobile}){
  const [d,setD]=useState(null);
  useEffect(()=>{
    let vivo=true;
    const carregar=()=>acoes.relatorio({de:diasAtras(30),ate:hojeISO()}).then(r=>vivo&&setD(r)).catch(()=>{});
    carregar(); const t=setInterval(carregar,30000);
    return()=>{vivo=false;clearInterval(t);};
  },[]);

  if(!d) return <div style={{height:"100%",display:"flex",alignItems:"center",justifyContent:"center",color:C.faint,fontSize:13,gap:8}}><Icon n="loader" size={16} spin/> Carregando o painel…</div>;

  const team=d.atendentes;
  const medianas=team.map(a=>a.primeira_resposta_mediana_min).filter(x=>x>0);
  const medianaGeral=medianas.length?Math.round(medianas.reduce((a,b)=>a+b,0)/medianas.length):0;
  const ranked=[...team].sort((a,b)=>b.vendas-a.vendas||b.conversao-a.conversao);
  const maxBar=Math.max(1,...team.map(a=>a.recebidos));
  const totalPorEtapa=(st)=>team.reduce((s,a)=>s+(a.por_etapa[st]||0),0);
  const corDe=(id)=>COLORS[[...id].reduce((s,c)=>s+c.charCodeAt(0),0)%COLORS.length];
  const disponivel=(id)=>(pessoas.find(p=>p.id===id)||{}).available;

  return <div style={{height:"100%",overflowY:"auto",WebkitOverflowScrolling:"touch",padding:isMobile?14:20}}>
    <div style={{maxWidth:1020,margin:"0 auto"}}>
      {fila.length>0&&<button onClick={()=>setView("conversas")} style={{width:"100%",textAlign:"left",background:C.hotSoft,border:`1px solid ${C.hot}40`,borderRadius:12,padding:12,marginBottom:16,display:"flex",alignItems:"center",gap:12,cursor:"pointer"}}>
        <Icon n="flame" size={18} color={C.hot}/><span style={{color:C.ink,fontSize:13,fontWeight:500,flex:1}}>{fila.length} lead(s) na fila aguardando distribuição.</span><Icon n="chevron" size={15} color={C.hot}/>
      </button>}
      <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:16}}>
        <Metric n="users" label="Leads (30 dias)" value={d.total.leads} accent={C.cool}/>
        <Metric n="clock" label="1ª resposta (mediana)" value={medianaGeral+" min"} sub="meta: até 10 min" accent={medianaGeral<=10?C.green:C.amber}/>
        <Metric n="check" label="Vendas" value={d.total.vendas} accent={C.greenDeep}/>
        <Metric n="award" label="Valor vendido" value={fmtMoeda(d.total.valor_vendido)} accent={C.green}/>
      </div>
      <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16,marginBottom:16}}>
        <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:12}}>Avanço de leads por etapa (equipe)</div>
        <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:4}}>
          {STAGES.map(st=>{const v=totalPorEtapa(st);
            return <div key={st} style={{flexShrink:0,width:92}}><div style={{background:STAGE_C[st]+"14",border:`1px solid ${STAGE_C[st]}40`,borderRadius:12,padding:8,textAlign:"center"}}><div style={{color:STAGE_C[st],fontFamily:MONO,fontSize:20,fontWeight:700,lineHeight:1}}>{v}</div><div style={{color:C.sub,fontSize:10,marginTop:4,lineHeight:1.1}}>{st}</div></div></div>;})}
        </div>
      </div>
      {team.length===0?<div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:32,textAlign:"center"}}>
        <Icon n="userplus" size={26} color={C.faint}/>
        <div style={{color:C.ink,fontSize:14,fontWeight:600,marginTop:10}}>Nenhum corretor cadastrado ainda</div>
        <div style={{color:C.faint,fontSize:12.5,marginTop:6,lineHeight:1.5}}>Mande o link de cadastro para a equipe. Assim que eles criarem a conta,<br/>aparecem aqui e passam a receber leads na catraca.</div>
      </div>
      :<div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"3fr 2fr",gap:16}} className="dashgrid">
        <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16}}>
          <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:14}}>Comparativo por corretor</div>
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            {team.map(a=><div key={a.id}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:4,gap:8}}><span style={{color:C.ink,fontWeight:600}}>{first(a.nome)}</span><span style={{color:C.faint,fontFamily:MONO}}>{a.recebidos} leads · {a.vendas} vendas</span></div>
              <div style={{display:"flex",height:16,borderRadius:6,overflow:"hidden",background:C.surface}}>
                <div style={{width:a.recebidos/maxBar*100+"%",background:C.cool,height:"100%"}} title="recebidos"/>
                <div style={{width:a.atendidos/maxBar*100+"%",background:C.green,height:"100%"}} title="atendidos"/>
                <div style={{width:a.vendas/maxBar*100+"%",background:C.greenDeep,height:"100%"}} title="vendas"/>
              </div>
            </div>)}
          </div>
          <div style={{display:"flex",gap:14,marginTop:12}}>{[["Recebidos",C.cool],["Atendidos",C.green],["Vendas",C.greenDeep]].map(([l,c])=><div key={l} style={{display:"flex",alignItems:"center",gap:5}}><span style={{width:10,height:10,borderRadius:3,background:c}}/><span style={{color:C.sub,fontSize:11}}>{l}</span></div>)}</div>
        </div>
        <div style={{background:C.card,border:`1px solid ${C.line}`,borderRadius:16,padding:16}}>
          <div style={{color:C.ink,fontSize:13,fontWeight:700,marginBottom:12}}>Ranking & tempo de resposta</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {ranked.map((a,i)=><button key={a.id} onClick={()=>setView("relatorios")} style={{width:"100%",display:"flex",alignItems:"center",gap:10,borderRadius:12,padding:10,textAlign:"left",border:"none",cursor:"pointer",background:C.surface}}>
              <span style={{color:i===0?C.green:C.faint,fontFamily:MONO,fontSize:14,fontWeight:700,width:20}}>{i+1}º</span>
              <Avatar ini={initials(a.nome)} color={corDe(a.id)} size={30}/>
              <div style={{minWidth:0,flex:1}}>
                <div style={{color:C.ink,fontSize:13,fontWeight:600,display:"flex",alignItems:"center",gap:4}}>{first(a.nome)} <span style={{color:disponivel(a.id)?C.green:C.faint,display:"inline-flex"}}><Icon n={disponivel(a.id)?"toggleOn":"toggleOff"} size={13}/></span></div>
                <div style={{color:a.primeira_resposta_mediana_min<=10?C.green:C.amber,fontSize:11,fontWeight:500}}>{a.primeira_resposta_mediana_min} min · {a.conversao}% conv.</div>
              </div>
              <div style={{textAlign:"right"}}><div style={{color:C.greenDeep,fontFamily:MONO,fontSize:16,fontWeight:700}}>{a.vendas}</div><div style={{color:C.faint,fontSize:10}}>vendas</div></div>
            </button>)}
          </div>
        </div>
      </div>}
    </div>
  </div>;
}

ReactDOM.createRoot(document.getElementById("root")).render(<ConCRM/>);
