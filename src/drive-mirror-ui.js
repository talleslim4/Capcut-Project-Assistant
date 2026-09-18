// O renderer já cria e atualiza os controles do espelho do Drive.
// Não use MutationObserver aqui: observar o body e reescrever os próprios
// nós observados cria um ciclo infinito e deixa a interface do Electron sem resposta.
