const PHRASES = [
  "Desembaraçando os fones de ouvido",
  "Avisando o Discord que você chegou",
  "Afinando o status",
  "Passando um café para o Discord",
  "Escolhendo a capa certa do álbum",
  "Ensaiando o Ouvindo",
  "Acordando os pixels",
  "Tirando o pó do status",
  "Apertando o play",
  "Esquentando o microfone",
  "Arrumando a bandeja",
  "Convencendo o Discord a prestar atenção",
  "Contando os megabytes um por um",
  "Pedindo licença para os outros apps",
  "Procurando o controle remoto"
];

const phrase = document.querySelector("#phrase");
const order = [...PHRASES];
for (let i = order.length - 1; i > 0; i -= 1) {
  const j = Math.floor(Math.random() * (i + 1));
  [order[i], order[j]] = [order[j], order[i]];
}

phrase.textContent = order[0];
let next = 1;
setInterval(() => {
  phrase.classList.add("leaving");
  setTimeout(() => {
    phrase.textContent = order[next];
    next = (next + 1) % order.length;
    phrase.classList.remove("leaving");
  }, 180);
}, 1600);
