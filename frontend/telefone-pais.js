/* O campo de WhatsApp das páginas de cadastro, com o país ao lado (02/11/2026).
   Pedido do Ali: uma corretora argentina da VJ não conseguia cadastrar o próprio
   número — a página tinha a máscara brasileira, que cortava em 11 dígitos.

   ligarTelefone(campo, seletor, api) → { pais(), conferir() }
   - O seletor nasce com o Brasil (funciona mesmo se a lista não carregar) e se
     completa com a lista do servidor (/publico/paises — a mesma que confere o
     número lá).
   - A máscara (87) 9 9999-9999 só vale para o Brasil; nos outros países o
     número é digitado livre, sem o código do país.
   - conferir() devolve a frase do problema, ou "" quando está bom. Quem decide
     de verdade é o servidor; isto só evita mandar um número claramente curto. */
(function(){
  function bandeira(iso){
    return String(iso||"").toUpperCase().replace(/[A-Z]/g, function(c){ return String.fromCodePoint(127397 + c.charCodeAt(0)); });
  }
  window.ligarTelefone = function(campo, seletor, api){
    var paises = { BR: { iso: "BR", nome: "Brasil", ddi: "55", min: 10, max: 11 } };
    function opcao(p){
      var o = document.createElement("option");
      o.value = p.iso; /* O código vem antes do nome: fechado, o seletor corta o fim, e o que precisa
         aparecer é o +54. */
      o.textContent = bandeira(p.iso) + " +" + p.ddi + "  " + p.nome;
      return o;
    }
    seletor.innerHTML = ""; seletor.appendChild(opcao(paises.BR)); seletor.value = "BR";
    try {
      fetch(api + "/publico/paises").then(function(r){ return r.json(); }).then(function(d){
        var lista = (d && d.paises) || []; if (!lista.length) return;
        var atual = seletor.value;
        lista.sort(function(a,b){ return a.iso === "BR" ? -1 : b.iso === "BR" ? 1 : a.nome.localeCompare(b.nome, "pt-BR"); });
        seletor.innerHTML = "";
        lista.forEach(function(p){ paises[p.iso] = p; seletor.appendChild(opcao(p)); });
        seletor.value = paises[atual] ? atual : "BR";
      }).catch(function(){});
    } catch (e) {}

    var dicaBR = campo.getAttribute("placeholder") || "(87) 9 9999-9999";
    function ajustar(){
      if (seletor.value === "BR") { campo.placeholder = dicaBR; mascarar(); }
      else campo.placeholder = "Número, sem o +" + (paises[seletor.value] || {}).ddi;
    }
    function mascarar(){
      if (seletor.value !== "BR" || campo.value.trim().charAt(0) === "+") return;
      var d = campo.value.replace(/\D/g, "").slice(0, 11), out = d;
      if (d.length > 2) out = "(" + d.slice(0,2) + ") " + d.slice(2);
      if (d.length > 7) out = "(" + d.slice(0,2) + ") " + d.slice(2,3) + " " + d.slice(3,7) + "-" + d.slice(7);
      else if (d.length > 6) out = "(" + d.slice(0,2) + ") " + d.slice(2,7);
      campo.value = out;
    }
    campo.addEventListener("input", mascarar);
    seletor.addEventListener("change", ajustar);

    return {
      pais: function(){ return seletor.value || "BR"; },
      conferir: function(){
        var bruto = campo.value.trim(), d = bruto.replace(/\D/g, "");
        if (!d) return "Informe o seu WhatsApp.";
        if (bruto.charAt(0) === "+") return d.length >= 8 ? "" : "Confira o WhatsApp: o número parece incompleto.";
        if (seletor.value === "BR") return d.length >= 10 ? "" : "Confira o WhatsApp: informe DDD + número.";
        var p = paises[seletor.value];
        return d.length >= ((p && p.min) || 6) ? "" : "Confira o WhatsApp: o número parece incompleto para " + (p ? p.nome : "esse país") + ".";
      }
    };
  };
})();
