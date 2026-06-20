<div align="center">
  <img src="build/icon.png" width="110" alt="Ícone do RickDev Presence Studio">

  # RickDev Presence Studio

  **Crie, visualize e controle sua Discord Rich Presence em uma interface simples e personalizável.**

  <p>
    <img src="https://img.shields.io/badge/versão-1.0.5-5865F2?style=for-the-badge" alt="Versão 1.0.5">
    <img src="https://img.shields.io/badge/plataforma-Windows-0078D4?style=for-the-badge&logo=windows" alt="Plataforma Windows">
    <img src="https://img.shields.io/badge/Electron-36-47848F?style=for-the-badge&logo=electron&logoColor=white" alt="Electron 36">
  </p>
</div>

---

## Sobre o projeto

O **RickDev Presence Studio** é um aplicativo desktop para configurar uma Rich Presence personalizada no Discord sem precisar editar código.

Você pode definir textos, imagens, botões e tempo decorrido, acompanhar o resultado em uma pré-visualização e salvar até cinco perfis diferentes para alternar rapidamente entre suas configurações.

## Recursos

- Interface moderna com pré-visualização em tempo real;
- cinco perfis independentes, personalizáveis e salvos automaticamente;
- textos de detalhes e estado da atividade;
- imagem grande e imagem pequena com textos ao passar o mouse;
- até dois botões com links externos;
- cronômetro opcional de tempo decorrido;
- modo de alta prioridade com reaplicação automática e preservação do tempo decorrido;
- inicialização minimizada com o Windows e ativação automática resiliente;
- aviso de novas versões com notas da release publicadas no GitHub;
- conexão, atualização e desconexão da presence pela interface;
- funcionamento em segundo plano pela bandeja do sistema;
- executável portátil para Windows, sem instalação.

## Primeiros passos

### 1. Crie um aplicativo no Discord

1. Acesse o [Discord Developer Portal](https://discord.com/developers/applications).
2. Clique em **New Application**, escolha um nome e confirme.
3. Na página **General Information**, copie o **Application ID**.
4. Cole o ID no campo **Application ID** do RickDev Presence Studio.

> O nome e o ícone configurados no Developer Portal identificam o aplicativo exibido na sua Rich Presence.

### 2. Adicione imagens

Para usar imagens personalizadas, abra seu aplicativo no Developer Portal e envie os arquivos na área de **Rich Presence Assets**.

Depois, informe no Studio exatamente a chave definida para cada imagem:

- **Chave da imagem grande:** imagem principal da atividade;
- **Chave da imagem pequena:** selo exibido sobre a imagem principal;
- **Texto da imagem:** mensagem mostrada ao passar o mouse.

As imagens podem levar alguns minutos para aparecer após o envio.

### 3. Ative sua presence

1. Mantenha o aplicativo desktop do Discord aberto.
2. Preencha os campos desejados no Studio.
3. Confira o resultado na pré-visualização.
4. Clique em **Ativar presence**.

Após a conexão, você pode editar os campos e clicar em **Atualizar presence** para publicar as alterações.

## Perfis

O aplicativo possui cinco perfis independentes. Cada perfil guarda seu próprio Application ID, textos, imagens, botões e configuração do cronômetro.

- Clique em uma aba para carregar outro perfil;
- altere o campo **Nome do perfil** para identificá-lo;
- todas as mudanças são salvas automaticamente no computador;
- trocar de perfil não altera a presence ativa até você clicar em **Atualizar presence**.

## Campos disponíveis

| Campo | Descrição | Limite ou formato |
| --- | --- | --- |
| Application ID | Identificador do aplicativo criado no Discord | 17 a 20 números |
| Detalhes | Texto principal da atividade | Até 128 caracteres |
| Estado | Texto complementar da atividade | Até 128 caracteres |
| Chave da imagem grande | Nome do asset principal no Developer Portal | Chave de um asset existente |
| Texto da imagem grande | Texto exibido ao passar o mouse | Até 128 caracteres |
| Chave da imagem pequena | Nome do asset secundário no Developer Portal | Chave de um asset existente |
| Texto da imagem pequena | Texto exibido ao passar o mouse | Até 128 caracteres |
| Botão 1 e Botão 2 | Texto dos botões da activity | Até 32 caracteres |
| URL dos botões | Endereço aberto ao clicar no botão | URL válida |
| Mostrar tempo decorrido | Exibe o tempo desde a ativação | Ligado ou desligado |
| Alta prioridade | Reaplica a presence a cada 60 segundos sem reiniciar o tempo | Ligado ou desligado |

> Para cada botão, preencha o texto e a URL juntos. O Discord pode não mostrar os botões para você na sua própria activity; teste visualizando seu perfil por outra conta.

## Executando o aplicativo

### Executável portátil

No Windows, execute o arquivo disponível na pasta `dist`:

```text
dist/RickDev Presence Studio.exe
```

Ao fechar a janela, o aplicativo continua ativo na bandeja do sistema para manter a presence conectada. Para encerrá-lo completamente, clique com o botão direito no ícone da bandeja e selecione **Encerrar**.

Ao habilitar **Iniciar com o Windows**, o Studio cria uma cópia gerenciada em `%LOCALAPPDATA%\RickDev Presence Studio`. O Windows usa essa cópia estável, portanto mover ou renomear o executável baixado não interrompe a inicialização automática. Para atualizar essa cópia, encerre a versão anterior pela bandeja e abra o novo executável; a substituição ocorre antes de o registro de inicialização ser renovado.

### Ambiente de desenvolvimento

Pré-requisitos:

- [Node.js](https://nodejs.org/) 18 ou mais recente;
- npm;
- Discord desktop instalado e aberto.

Clone o repositório, instale as dependências e inicie o projeto:

```powershell
npm install
npm start
```

Para gerar um novo executável portátil do Windows:

```powershell
npm run build
```

O arquivo gerado será salvo na pasta `dist`.

## Scripts

| Comando | Ação |
| --- | --- |
| `npm start` | Inicia o aplicativo |
| `npm run dev` | Inicia o aplicativo em ambiente de desenvolvimento |
| `npm run build` | Gera o executável portátil para Windows |

## Estrutura do projeto

```text
.
├── build/                  # Ícones usados pelo aplicativo e pelo build
├── dist/                   # Executável portátil gerado
├── src/
│   ├── renderer/           # Interface, estilos e comportamento da tela
│   ├── main.js             # Janela, bandeja, persistência e Discord RPC
│   └── preload.js          # Comunicação segura entre interface e processo principal
├── package.json
└── README.md
```

## Solução de problemas

### A presence não conecta

- Confirme que o Discord desktop está aberto e conectado;
- verifique se o Application ID possui somente números e foi copiado corretamente;
- tente desconectar e ativar a presence novamente;
- reinicie o Discord caso a conexão RPC não esteja disponível.

### As imagens não aparecem

- Confirme que as chaves informadas são exatamente iguais às cadastradas no Developer Portal;
- aguarde alguns minutos após enviar novos assets;
- verifique se os assets pertencem ao mesmo aplicativo do Application ID usado.

### Os botões não aparecem

- Preencha o texto e a URL do botão;
- use uma URL válida iniciada por `http://` ou `https://`;
- visualize seu perfil usando outra conta do Discord para testar.

---

<div align="center">
  Feito com Electron e Discord RPC.
</div>
