# Auditoria e evolução do Session Manager

Auditoria realizada antes das alterações, em 2026-09-13, na cópia
`carobaguard-dev`. As mudanças locais preexistentes de UI, recuperação do chat e CI
foram preservadas. A cópia `carobaguard` não foi alterada.

## Implementação encontrada

| Área | Implementação original | Lacuna identificada |
| --- | --- | --- |
| Criação | `opencode::create_session` iniciava o processo, criava `/session`, depois inseria `ai_sessions` | Falha no start impedia a própria criação do workspace; diretório persistido podia ser relativo |
| Persistência | SQLite/WAL: ID local/remoto, título, modo, autor e datas; conversa no armazenamento nativo OpenCode | Estado `ready` não acompanhava o filho; nenhum histórico consultável offline |
| Processo | Um `OpenCodeManager` em `AppState`; `opencode serve` em loopback com senha efêmera | Nenhum vínculo explícito entre o filho e a sessão local |
| Estados | `Sleeping`, `Starting`, `Ready`, `Error` somente em memória | Sem reconciliação no restart; cancelamento do start podia deixar estado transitório |
| Concorrência | `start_lock` serializava start/stop; `prompt_lock` limitava prompts; contador e geração protegiam requests | O intervalo entre escolher projeto, iniciar e enviar request não era protegido como operação única |
| PID/health | `Child::try_wait`, leitura de RSS em `/proc`; health no startup; reaper a cada 30 s | PID não persistido; leitura do corpo do health sem limite completo; ausência de health periódico |
| Encerramento | `kill_on_drop`, kill/wait de até 3 s e idle timeout | Filho direto apenas; startup HTTP cancelado e tarefas SSE exigiam cleanup explícito |
| Histórico/contexto | GET remoto dos últimos 200 textos; contexto injetado no prompt e removido da apresentação | Consultar histórico podia iniciar processo Read-Only e usar o diretório de outro processo ativo |
| Read-Only | Wildcard deny, deny explícito para bash/edit/task/skill; `--pure` | Relay de aprovação não conferia modo/sessão; LSP continuava autorizado |
| Approval | `ask` nas ferramentas mutadoras; respostas `once/always/reject` encaminhadas por ID | Backend não verificava a sessão solicitante; dependia da semântica de `always` da versão OpenCode |
| Unrestricted | Admin + frase exata; permissões `allow`; wake limitado pela autorização vigente | O runtime compartilhado não identificava o workspace ativo |
| Escopos | CRUD administrativo de `ai_permissions` | Registros por projeto/container/system não eram consultados no fluxo de chat; não constituíam isolamento de SO |
| SSE | Broadcast de 256 eventos; parser limitado a 4 MiB; aviso de eventos perdidos | Ausência de tarefas canceláveis explicitamente e de snapshot das permissões após reconexão |
| Audit Log | Ferramentas concluídas com deduplicação por callID, comando redigido/hash e ID de sessão | Não havia timeline de lifecycle/start de comando/permissões por sessão |
| Terminal | PTY separado por WebSocket, RBAC, origem/CSRF, limites de canais e tempo | Não pertence à conversa OpenCode; receiver cheio podia atrasar saída dos workers no cleanup |
| Logs | SSE Docker/systemd independente, limites de linhas/frames/tempo e cleanup | Não é stdout do OpenCode; não deve ser apresentado como tal |
| Git/UI | Runner Git protegido em `projects.rs`; HTML/CSS/JS estáticos | Reutilizáveis, sem necessidade de dependências ou serviços novos |

## Decisões aplicadas

Mantido o monólito Rust/Tokio/Axum, SQLite e o único processo OpenCode sob demanda.
O código de sessões fica em `src/opencode/session_manager.rs`, como parte do
adapter existente, usando os mesmos locks, cliente HTTP, broadcast e Audit Log.

1. Criação primeiro persiste o workspace, sem exigir OpenCode instalado/saudável.
   O ID remoto é criado no primeiro wake e reutilizado nas retomadas.
2. `created`, `sleeping`, `stopped`, `archived` e `error` são estados estáveis;
   `starting` e `stopping` são transitórios. Sleeping significa ausência de
   processo associado e admite permanência indefinida até retomada explícita.
3. O workspace lock cobre roteamento + request; transition lock cobre seleção e
   lifecycle; start lock protege criação/encerramento do processo. Operações
   incompatíveis recebem erro de busy. Decisões de aprovação continuam possíveis
   durante um prompt bloqueado.
4. Um filho saudável é reutilizado quando diretório e modo são compatíveis.
   Trocar de sessão limpa grants e pedidos temporários e desassocia o PID antigo.
5. Restart reconcilia metadados, sem confiar em PID persistido nem tentar matar
   processos arbitrários. Um `flock` do diretório de dados impede dois backends
   concorrentes. No Linux o filho usa grupo próprio, parent-death signal e
   `no_new_privs`; shutdown mata/recolhe o grupo gerenciado.
6. Histórico local é atualizado por mensagens/eventos e reconciliação remota.
   Consultas offline usam SQLite e não acordam o agente. Os limites de leitura
   permanecem explícitos (200 mensagens, 4 MiB por resposta/mensagem armazenada).
7. Timeline é uma consulta indexada de `audit_events`, limitada a 200 eventos por
   detalhe. Nenhum barramento ou banco de auditoria paralelo foi criado.
8. `always` nunca é enviado ao OpenCode. Allow for session guarda somente a
   assinatura da ação solicitada em memória, vinculada ao ID local, e responde
   `once` nas repetições correspondentes. Sleep/stop/troca/restart descartam grants.
   Read-Only não pode autorizar mutações; LSP também fica bloqueado nesse modo.
9. Git usa o runner existente: argumentos fixos, sem hooks/fsmonitor/pager,
   optional locks desativados, timeout de 5 s e output limitado.
10. O painel exibe output das ferramentas. O terminal administrativo continua
    independente; não vira uma saída alternativa para contornar Read-Only.

## API

Todas as rotas estão sob `/api/v1/opencode`. Leituras exigem Operator/Admin;
mutations exigem CSRF, e operações Unrestricted preservam os controles de Admin.

| Método e rota | Efeito |
| --- | --- |
| GET `/sessions` | Lista os 100 registros mais recentes |
| POST `/sessions` | Cria metadados; aceita title, project_path e permission_mode |
| GET `/sessions/{id}` | Metadados, Git, timeline, output e pedidos pendentes |
| GET `/sessions/{id}/messages` | Histórico local; reconcilia quando o workspace está ativo |
| POST `/sessions/{id}/messages` | Acorda conforme política e envia um prompt |
| POST `/sessions/{id}/actions` | `action`: start/resume, rename (title), sleep, stop, archive |
| DELETE `/sessions/{id}` | Exige que esteja parada; remove registro e cache local |
| POST `/permissions/{request_id}` | Exige session_id local; reply once/always/reject |
| GET `/events` | SSE existente, mais `carobaguard.session.changed` |

Excluir remove a sessão da gestão CarobaGuard e seu cache local. Preserva arquivos,
Audit Log e histórico nativo OpenCode; a resposta explicita
`native_history_retained: true`. Arquivar preserva tudo e bloqueia novos prompts.
Sessões antigas ainda sem cache local precisam de um wake para a primeira
sincronização. O armazenamento nativo OpenCode deve continuar incluído no backup
para garantir a retomada completa do contexto do modelo.

Desconectar o navegador não cancela um prompt já aceito: o trabalho tem prazo de
15 minutos e pode ser recuperado pelo histórico. Sleep/stop interrompem o agente;
falhas/timeouts tentam abortar o prompt remoto. SSE e reaper encerram no shutdown.

## Validação reproduzível

```sh
cargo fmt
cargo clippy -- -D warnings
cargo clippy --all-targets --all-features -- -D warnings
cargo test
node --check web/app.js
node --check web/chat-recovery.js
node --test tests/*.test.js
cargo build --locked
python3 tests/session-manager.integration.py
CAROBAGUARD_TEST_OPENCODE=/path/to/opencode cargo test real_opencode_mapping_survives_sleep_without_provider_calls -- --ignored
git diff --check
```

A fixture Python usa apenas a biblioteca padrão e só participa dos testes.
A integração HTTP inicia backends temporários, testa restart, morte do filho,
concorrência, Git, histórico e exclusão. A verificação com OpenCode real não chama
provedores nem modelos e remove apenas a sessão nativa criada pelo próprio teste.
