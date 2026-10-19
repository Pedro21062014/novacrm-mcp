/** novacrm-mcp — suíte e2e do servidor STDIO (sem dependências).
 *
 * Sobe uma API v1 simulada (envelope real { success, data, meta }), spawn o
 * servidor com node e fala JSON-RPC 2.0 pelo stdin/stdout:
 *
 *   - initialize (serverInfo, protocolVersion, capabilities)
 *   - notifications/initialized (sem resposta, sem chamada à API)
 *   - ping, tools/list (50 ferramentas, prefixo novacrm_, schemas)
 *   - tools/call de leitura (list_products com Bearer correto + paginação)
 *   - tools/call novacrm_ping (status connected, ambiente production)
 *   - tools/call de escrita (create_product, update_order_status com status REAL)
 *   - query params compostos (inventory_alerts com threshold)
 *   - list_clients com includeArchived, delete_product com permanent=true,
 *     get_metrics com detail=revenue
 *   - importação em lote (imports/clients)
 *   - ferramentas novas: automações (criar + pausar), tarefas (criar + concluir),
 *     propostas (criar + mudar status), pipeline (criar + mover de estágio)
 *   - erro de envelope da API (422 → isError=true preservando código/mensagem)
 *   - prompts/list, prompts/get (com e sem argumentos), prompt inexistente
 *   - lote JSON-RPC (batch de 2 requisições em uma linha)
 *   - parse error (-32700), método desconhecido (-32601),
 *     ferramenta desconhecida, execução sem NOVACRM_API_KEY
 *
 * Roda sem backend e sem ferramentas extras: node test/e2e.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverEntry = path.join(root, 'index.mjs');

let checks = 0;
const check = (v, label) => { assert.ok(v, label); checks++; console.log('  ✓ ' + label); };

const MERCHANT = 'm1';
const KEY_ID = 'k1';
const SECRET = 's3cret-Test';
const API_KEY = `ncrm_live.${MERCHANT}.${KEY_ID}.${SECRET}`;

// ============================================================================
// API v1 SIMULADA
// ============================================================================
const apiCalls = [];
const apiServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    apiCalls.push({ method: req.method || 'GET', path: req.url || '/', auth: req.headers.authorization, body });
    const ok = (data, meta = { apiVersion: 'v1' }, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data, meta }));
    };
    const fail = (status, code, message) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: { code, message } }));
    };
    const url = req.url || '';

    if (url === '/api/v1/analytics') return ok({ analytics: { financial: { revenue: 1234.5, currency: 'BRL' }, orders: { total: 42 } } });
    if (url === '/api/v1/analytics/revenue') return ok({ analytics: { revenue: { paid: 1234.5, currency: 'BRL', averageTicket: 58.7 } } });
    if (url === '/api/v1/analytics/visits') return ok({ analytics: { visits: { window: 'last_30_days', pageviews: 342, uniqueVisitors: 218, productViews: 501, checkouts: 74, checkoutRate: 34, daily: [{ date: '2026-10-19', pageviews: 21, uniqueVisitors: 15 }], byDevice: [{ name: 'mobile', value: 271 }], byReferrer: [{ name: 'direct', value: 190 }], topViewedProducts: [{ productId: 'p1', name: 'Camiseta NovaCRM', views: 96 }] } } });
    if (url.startsWith('/api/v1/products') && req.method === 'GET') {
      return ok({ products: [{ id: 'p1', name: 'Camiseta NovaCRM', price: 49.9, stock: 12 }] }, { apiVersion: 'v1', pagination: { total: 1, limit: 50, offset: 0 } });
    }
    if (url.startsWith('/api/v1/products') && req.method === 'POST') {
      return ok({ product: { id: 'p2', name: body.name, price: body.price, stock: body.stock ?? 0 } }, { apiVersion: 'v1' }, 201);
    }
    if (url.startsWith('/api/v1/products/') && req.method === 'DELETE') {
      const id = url.split('/api/v1/products/')[1].split('?')[0];
      return ok({ deleted: id, permanent: url.includes('permanent=true') });
    }
    if (url.startsWith('/api/v1/orders/o1/status') && req.method === 'PATCH') {
      return ok({ order: { id: 'o1', status: body.status, customerName: 'Ana' } });
    }
    if (url.startsWith('/api/v1/clients') && req.method === 'GET') {
      return ok({ clients: [{ id: 'c1', name: 'Ana Souza', phone: '11987654321' }] }, { apiVersion: 'v1', pagination: { total: 1, limit: 50, offset: 0 } });
    }
    if (url.startsWith('/api/v1/clients') && req.method === 'POST') {
      return fail(422, 'validation_error', 'Informe name para criar o cliente.');
    }
    if (url === '/api/v1/imports/clients' && req.method === 'POST') {
      const records = Array.isArray(body?.records) ? body.records : [];
      return ok({ import: { resource: 'clients', requested: records.length, created: records.length } }, { apiVersion: 'v1' }, 201);
    }
    if (url === '/api/v1/inventory/alerts?threshold=3') {
      return ok({ inventory: [{ id: 'p1', name: 'Camiseta NovaCRM', stock: 2 }] });
    }

    // ---- Novos recursos: automações, tarefas, propostas, pipeline ----
    if (url.startsWith('/api/v1/automations') && req.method === 'GET') {
      return ok({ automations: [{ id: 'a1', name: 'Follow-up pós-compra', active: true, trigger: 'order_paid', stats: { executions: 9 } }] }, { apiVersion: 'v1', pagination: { total: 1, limit: 50, offset: 0 } });
    }
    if (url === '/api/v1/automations' && req.method === 'POST') {
      return ok({ automation: { id: 'a2', name: body.name, active: true, trigger: body.trigger, action: { type: body.actionType, config: body.actionConfig } } }, { apiVersion: 'v1' }, 201);
    }
    if (url.startsWith('/api/v1/automations/') && req.method === 'PATCH') {
      const id = url.split('/api/v1/automations/')[1].split('?')[0];
      return ok({ automation: { id, active: body.isActive === true } });
    }
    if (url.startsWith('/api/v1/automations/') && req.method === 'DELETE') {
      const id = url.split('/api/v1/automations/')[1].split('?')[0];
      return ok({ deletion: { id, permanent: true } });
    }

    if (url.startsWith('/api/v1/tasks') && req.method === 'GET') {
      return ok({ tasks: [{ id: 't1', title: 'Retornar para Ana', status: 'pending', dueDate: '2026-10-20' }] }, { apiVersion: 'v1', pagination: { total: 1, limit: 50, offset: 0 } });
    }
    if (url === '/api/v1/tasks' && req.method === 'POST') {
      return ok({ task: { id: 't2', title: body.title, dueDate: body.dueDate, status: 'pending' } }, { apiVersion: 'v1' }, 201);
    }
    if (url.startsWith('/api/v1/tasks/') && url.endsWith('/complete') && req.method === 'POST') {
      const id = url.split('/api/v1/tasks/')[1].split('/complete')[0];
      return ok({ task: { id, status: 'completed', completedAt: '2026-10-19T12:00:00.000Z' } });
    }
    if (url.startsWith('/api/v1/tasks/') && req.method === 'PATCH') {
      const id = url.split('/api/v1/tasks/')[1].split('?')[0];
      return ok({ task: { id, ...body } });
    }

    if (url.startsWith('/api/v1/proposals') && req.method === 'GET') {
      return ok({ proposals: [{ id: 'pr1', title: 'Pacote Q4', status: 'sent', totals: { total: 2300 } }] }, { apiVersion: 'v1', pagination: { total: 1, limit: 50, offset: 0 } });
    }
    if (url === '/api/v1/proposals' && req.method === 'POST') {
      return ok({ proposal: { id: 'pr2', title: body.title, client: { name: body.clientName }, status: body.status ?? 'draft', totals: { total: 2300 } } }, { apiVersion: 'v1' }, 201);
    }
    if (url.startsWith('/api/v1/proposals/') && req.method === 'PATCH') {
      const id = url.split('/api/v1/proposals/')[1].split('?')[0];
      return ok({ proposal: { id, status: body.status } });
    }

    if (url.startsWith('/api/v1/opportunities') && req.method === 'GET') {
      return ok({ opportunities: [{ id: 'op1', title: 'Upgrade premium', stage: 'negotiation', value: 4500 }] }, { apiVersion: 'v1', pagination: { total: 1, limit: 50, offset: 0 } });
    }
    if (url === '/api/v1/opportunities' && req.method === 'POST') {
      return ok({ opportunity: { id: 'op2', title: body.title, stage: body.stage ?? 'lead', value: body.value } }, { apiVersion: 'v1' }, 201);
    }
    if (url.startsWith('/api/v1/opportunities/') && url.endsWith('/stage') && req.method === 'PATCH') {
      const id = url.split('/api/v1/opportunities/')[1].split('/stage')[0];
      return ok({ opportunity: { id, stage: body.stage, probability: body.stage === 'won' ? 100 : 0, lossReason: body.lossReason } });
    }
    if (url.startsWith('/api/v1/opportunities/') && req.method === 'DELETE') {
      const id = url.split('/api/v1/opportunities/')[1].split('?')[0];
      return ok({ deletion: { id, permanent: true } });
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: { code: 'route_not_found', message: url } }));
  });
});
await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
const apiPort = apiServer.address().port;
const baseUrl = `http://127.0.0.1:${apiPort}/api/v1`;

// ============================================================================
// CLIENTE JSON-RPC SOBRE O PROCESSO FILHO
// ============================================================================
const child = spawn('node', [serverEntry], {
  env: { ...process.env, NOVACRM_API_KEY: API_KEY, NOVACRM_BASE_URL: baseUrl },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const rl = readline.createInterface({ input: child.stdout, terminal: false });
const pending = new Map();
let nextId = 0;
const stderr = [];
const protocolErrors = [];
child.stderr.on('data', (d) => stderr.push(d.toString('utf8')));
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const items = Array.isArray(msg) ? msg : [msg];
  for (const item of items) {
    if (item && item.id !== undefined && pending.has(item.id)) pending.get(item.id)(item);
    if (item && item.id === null && item.error) protocolErrors.push(item.error.code);
  }
});
const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => reject(new Error(`timeout aguardando resposta de ${method}`)), 15000);
  pending.set(id, (msg) => { clearTimeout(timer); pending.delete(id); resolve(msg); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
const tool = (name, args = {}) => call('tools/call', { name, arguments: args });

try {
  console.log('\n— novacrm-mcp: servidor STDIO contra API v1 simulada —');

  // initialize
  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'teste', version: '0' } });
  check(init.result?.serverInfo?.name === 'novacrm-mcp-server', 'initialize devolve serverInfo novacrm-mcp-server');
  check(init.result?.protocolVersion === '2024-11-05', 'initialize negocia protocolVersion 2024-11-05');
  check(!!init.result?.capabilities?.tools, 'initialize anuncia capability tools');
  notify('notifications/initialized');
  await new Promise((r) => setTimeout(r, 150));
  check(apiCalls.length === 0, 'notifications/initialized não gera chamada à API nem resposta');

  // ping / tools/list
  const ping = await call('ping');
  check(ping.result && JSON.stringify(ping.result) === '{}', 'ping devolve result vazio');
  const tools = await call('tools/list');
  const catalog = tools.result?.tools;
  check(Array.isArray(catalog) && catalog.length === 50, `tools/list devolve 50 ferramentas (${catalog?.length})`);
  check(catalog.every((t) => t.name.startsWith('novacrm_')), 'todas as ferramentas têm o prefixo novacrm_');
  check(catalog.every((t) => t.inputSchema?.type === 'object'), 'todas as ferramentas têm inputSchema object');
  const requiredTool = catalog.find((t) => t.name === 'novacrm_create_product');
  check(JSON.stringify(requiredTool?.inputSchema?.required) === JSON.stringify(['name', 'price']), 'novacrm_create_product exige name e price');
  const statusTool = catalog.find((t) => t.name === 'novacrm_update_order_status');
  check(JSON.stringify(statusTool?.inputSchema?.properties?.status?.enum) === JSON.stringify(['pending_payment', 'new', 'processing', 'completed', 'cancelled']), 'status de pedido usa os valores REAIS da API v1');
  const triggerTool = catalog.find((t) => t.name === 'novacrm_create_automation');
  check(JSON.stringify(triggerTool?.inputSchema?.properties?.trigger?.enum) === JSON.stringify(['client_created', 'order_created', 'order_paid', 'proposal_approved', 'opportunity_won', 'inactive_client_30d']), 'gatilho de automação usa os valores REAIS da API v1');
  const stageTool = catalog.find((t) => t.name === 'novacrm_move_opportunity');
  check(JSON.stringify(stageTool?.inputSchema?.properties?.stage?.enum) === JSON.stringify(['lead', 'contact', 'proposal', 'negotiation', 'won', 'lost']), 'estágio do pipeline usa os valores REAIS da API v1');
  const taskRequired = catalog.find((t) => t.name === 'novacrm_create_task');
  check(JSON.stringify(taskRequired?.inputSchema?.required) === JSON.stringify(['title', 'dueDate']), 'novacrm_create_task exige title e dueDate');
  for (const family of ['list_automations', 'list_tasks', 'list_proposals', 'list_opportunities']) check(catalog.some((t) => t.name === `novacrm_${family}`), `ferramenta novacrm_${family} presente no catálogo`);

  // tools/call — leitura
  const list = await tool('novacrm_list_products', { limit: 10 });
  const lastList = apiCalls[apiCalls.length - 1];
  check(lastList?.method === 'GET' && lastList?.path === '/api/v1/products?limit=10', 'list_products chama GET /api/v1/products?limit=10');
  check(lastList?.auth === `Bearer ${API_KEY}`, 'requisição leva o header Authorization Bearer da chave');
  check(list.result?.isError === false && list.result.content[0].text.includes('Camiseta NovaCRM'), 'list_products devolve os produtos da API simulada');
  check(list.result.content[0].text.includes('"pagination"'), 'list_products inclui a paginação do meta');

  // tools/call — ping
  const pingTool = await tool('novacrm_ping');
  check(pingTool.result?.content?.[0]?.text.includes('"status": "connected"'), 'novacrm_ping reporta status connected');
  check(pingTool.result?.content?.[0]?.text.includes('"environment": "production"'), 'novacrm_ping detecta ambiente production (ncrm_live)');

  // tools/call — escrita
  const created = await tool('novacrm_create_product', { name: 'Caneca NovaCRM', price: 29.9, stock: 5 });
  const lastCreate = apiCalls[apiCalls.length - 1];
  check(lastCreate?.method === 'POST' && lastCreate?.path === '/api/v1/products', 'create_product chama POST /api/v1/products');
  check(lastCreate?.body?.name === 'Caneca NovaCRM' && lastCreate?.body?.price === 29.9, 'create_product envia o body JSON correto');
  check(created.result?.isError === false && created.result.content[0].text.includes('p2'), 'create_product devolve o produto criado');

  const statusUpdate = await tool('novacrm_update_order_status', { id: 'o1', status: 'completed' });
  const lastStatus = apiCalls[apiCalls.length - 1];
  check(lastStatus?.method === 'PATCH' && lastStatus?.path === '/api/v1/orders/o1/status', 'update_order_status chama PATCH /api/v1/orders/o1/status');
  check(lastStatus?.body?.status === 'completed', 'update_order_status envia o novo status');
  check(statusUpdate.result?.isError === false && statusUpdate.result.content[0].text.includes('"completed"'), 'update_order_status devolve o pedido atualizado');

  // tools/call — query params compostos
  await tool('novacrm_inventory_alerts', { threshold: 3 });
  const lastAlerts = apiCalls[apiCalls.length - 1];
  check(lastAlerts?.path === '/api/v1/inventory/alerts?threshold=3', 'inventory_alerts repassa o threshold na query');

  // tools/call — list_clients com includeArchived
  const clients = await tool('novacrm_list_clients', { includeArchived: true });
  const lastClients = apiCalls[apiCalls.length - 1];
  check(lastClients?.method === 'GET' && lastClients?.path === '/api/v1/clients?includeArchived=true', 'list_clients repassa includeArchived=true na query');
  check(clients.result?.isError === false && clients.result.content[0].text.includes('Ana Souza'), 'list_clients devolve os clientes da API simulada');

  // tools/call — delete_product com permanent
  const deleted = await tool('novacrm_delete_product', { id: 'p9', permanent: true });
  const lastDelete = apiCalls[apiCalls.length - 1];
  check(lastDelete?.method === 'DELETE' && lastDelete?.path === '/api/v1/products/p9?permanent=true', 'delete_product chama DELETE com permanent=true');
  check(deleted.result?.isError === false && deleted.result.content[0].text.includes('"permanent": true'), 'delete_product devolve o resultado da exclusão');

  // tools/call — get_metrics com detail
  const metrics = await tool('novacrm_get_metrics', { detail: 'revenue' });
  const lastMetrics = apiCalls[apiCalls.length - 1];
  check(lastMetrics?.method === 'GET' && lastMetrics?.path === '/api/v1/analytics/revenue', 'get_metrics detail=revenue chama GET /api/v1/analytics/revenue');
  check(metrics.result?.isError === false && metrics.result.content[0].text.includes('averageTicket'), 'get_metrics devolve a visão detalhada de faturamento');

  // tools/call — visitas à loja pública (analytics/visits)
  const visits = await tool('novacrm_get_store_visits', {});
  const lastVisits = apiCalls[apiCalls.length - 1];
  check(lastVisits?.method === 'GET' && lastVisits?.path === '/api/v1/analytics/visits', 'get_store_visits chama GET /api/v1/analytics/visits');
  check(visits.result?.isError === false && visits.result.content[0].text.includes('uniqueVisitors') && visits.result.content[0].text.includes('topViewedProducts'), 'get_store_visits devolve visitantes únicos e produtos mais vistos');
  const visitsDetail = await tool('novacrm_get_metrics', { detail: 'visits' });
  check(apiCalls[apiCalls.length - 1]?.path === '/api/v1/analytics/visits', 'get_metrics detail=visits também alcança a rota de visitas');
  check(visitsDetail.result?.isError === false, 'get_metrics detail=visits devolve o agregado sem erro');

  // tools/call — importação em lote
  const imported = await tool('novacrm_import_clients', { records: [{ name: 'Ana' }, { name: 'Bia' }, { name: 'Caio' }] });
  const lastImport = apiCalls[apiCalls.length - 1];
  check(lastImport?.method === 'POST' && lastImport?.path === '/api/v1/imports/clients', 'import_clients chama POST /api/v1/imports/clients');
  check(lastImport?.body?.records?.length === 3, 'import_clients envia os records no body');
  check(imported.result?.isError === false && imported.result.content[0].text.includes('"created": 3'), 'import_clients devolve o resumo da importação');

  // tools/call — erro de envelope da API (422)
  const errCall = await tool('novacrm_create_client', { phone: '11999' });
  check(errCall.result?.isError === true, 'erro da API vira isError=true no MCP');
  check(errCall.result?.content?.[0]?.text.includes('validation_error') && errCall.result.content[0].text.includes('Informe name'), 'mensagem de erro preserva código e mensagem do envelope');

  // tools/call — automações
  const automations = await tool('novacrm_list_automations', { includeArchived: true });
  const lastAutomations = apiCalls[apiCalls.length - 1];
  check(lastAutomations?.method === 'GET' && lastAutomations?.path === '/api/v1/automations?includeArchived=true', 'list_automations repassa includeArchived na query');
  check(automations.result?.isError === false && automations.result.content[0].text.includes('Follow-up pós-compra'), 'list_automations devolve as regras da API simulada');
  const automationCreated = await tool('novacrm_create_automation', { name: 'Follow-up 3 dias', trigger: 'proposal_approved', actionType: 'create_task', actionConfig: { taskTitle: 'Retomar proposta', delayDays: 3 } });
  const lastAutomationCreate = apiCalls[apiCalls.length - 1];
  check(lastAutomationCreate?.method === 'POST' && lastAutomationCreate?.path === '/api/v1/automations', 'create_automation chama POST /api/v1/automations');
  check(lastAutomationCreate?.body?.trigger === 'proposal_approved' && lastAutomationCreate?.body?.actionConfig?.delayDays === 3, 'create_automation envia gatilho e actionConfig no body');
  check(automationCreated.result?.isError === false && automationCreated.result.content[0].text.includes('a2'), 'create_automation devolve a regra criada');
  const automationPaused = await tool('novacrm_update_automation', { id: 'a2', isActive: false });
  const lastAutomationUpdate = apiCalls[apiCalls.length - 1];
  check(lastAutomationUpdate?.method === 'PATCH' && lastAutomationUpdate?.path === '/api/v1/automations/a2' && lastAutomationUpdate?.body?.isActive === false, 'update_automation pausa a regra via PATCH');
  check(automationPaused.result?.isError === false, 'update_automation devolve a regra atualizada');

  // tools/call — tarefas
  const tasks = await tool('novacrm_list_tasks', { status: 'pending' });
  const lastTasks = apiCalls[apiCalls.length - 1];
  check(lastTasks?.method === 'GET' && lastTasks?.path === '/api/v1/tasks?status=pending', 'list_tasks repassa o filtro de status na query');
  check(tasks.result?.isError === false && tasks.result.content[0].text.includes('Retornar para Ana'), 'list_tasks devolve as tarefas da API simulada');
  const taskCreated = await tool('novacrm_create_task', { title: 'Ligar para Bia', dueDate: '2026-10-21', type: 'call', priority: 'high' });
  const lastTaskCreate = apiCalls[apiCalls.length - 1];
  check(lastTaskCreate?.method === 'POST' && lastTaskCreate?.path === '/api/v1/tasks', 'create_task chama POST /api/v1/tasks');
  check(lastTaskCreate?.body?.title === 'Ligar para Bia' && lastTaskCreate?.body?.dueDate === '2026-10-21', 'create_task envia título e vencimento no body');
  check(taskCreated.result?.isError === false && taskCreated.result.content[0].text.includes('t2'), 'create_task devolve a tarefa criada');
  const taskDone = await tool('novacrm_complete_task', { id: 't2' });
  const lastTaskComplete = apiCalls[apiCalls.length - 1];
  check(lastTaskComplete?.method === 'POST' && lastTaskComplete?.path === '/api/v1/tasks/t2/complete', 'complete_task chama POST /api/v1/tasks/t2/complete');
  check(taskDone.result?.isError === false && taskDone.result.content[0].text.includes('"completed"'), 'complete_task devolve a tarefa concluída');

  // tools/call — propostas
  const proposals = await tool('novacrm_list_proposals', { status: 'sent' });
  const lastProposals = apiCalls[apiCalls.length - 1];
  check(lastProposals?.method === 'GET' && lastProposals?.path === '/api/v1/proposals?status=sent', 'list_proposals repassa o filtro de status na query');
  check(proposals.result?.isError === false && proposals.result.content[0].text.includes('Pacote Q4'), 'list_proposals devolve as propostas da API simulada');
  const proposalCreated = await tool('novacrm_create_proposal', { title: 'Pacote Corporativo', clientName: 'Ana Souza', items: [{ name: 'Licença anual', quantity: 2, unitPrice: 1200 }], discount: 100 });
  const lastProposalCreate = apiCalls[apiCalls.length - 1];
  check(lastProposalCreate?.method === 'POST' && lastProposalCreate?.path === '/api/v1/proposals', 'create_proposal chama POST /api/v1/proposals');
  check(lastProposalCreate?.body?.items?.length === 1 && lastProposalCreate?.body?.discount === 100, 'create_proposal envia itens e desconto no body');
  check(proposalCreated.result?.isError === false && proposalCreated.result.content[0].text.includes('pr2'), 'create_proposal devolve a proposta criada');
  const proposalSent = await tool('novacrm_update_proposal', { id: 'pr2', status: 'approved' });
  const lastProposalUpdate = apiCalls[apiCalls.length - 1];
  check(lastProposalUpdate?.method === 'PATCH' && lastProposalUpdate?.path === '/api/v1/proposals/pr2' && lastProposalUpdate?.body?.status === 'approved', 'update_proposal muda o status via PATCH');
  check(proposalSent.result?.isError === false, 'update_proposal devolve a proposta atualizada');

  // tools/call — pipeline (oportunidades)
  const opportunities = await tool('novacrm_list_opportunities', { stage: 'negotiation' });
  const lastOpportunities = apiCalls[apiCalls.length - 1];
  check(lastOpportunities?.method === 'GET' && lastOpportunities?.path === '/api/v1/opportunities?stage=negotiation', 'list_opportunities repassa o filtro de estágio na query');
  check(opportunities.result?.isError === false && opportunities.result.content[0].text.includes('Upgrade premium'), 'list_opportunities devolve os negócios da API simulada');
  const opportunityCreated = await tool('novacrm_create_opportunity', { title: 'Upgrade premium', clientName: 'Ana Souza', value: 4500, stage: 'negotiation', probability: 60 });
  const lastOpportunityCreate = apiCalls[apiCalls.length - 1];
  check(lastOpportunityCreate?.method === 'POST' && lastOpportunityCreate?.path === '/api/v1/opportunities', 'create_opportunity chama POST /api/v1/opportunities');
  check(lastOpportunityCreate?.body?.stage === 'negotiation' && lastOpportunityCreate?.body?.value === 4500, 'create_opportunity envia estágio e valor no body');
  check(opportunityCreated.result?.isError === false && opportunityCreated.result.content[0].text.includes('op2'), 'create_opportunity devolve o negócio criado');
  const moved = await tool('novacrm_move_opportunity', { id: 'op2', stage: 'won' });
  const lastMove = apiCalls[apiCalls.length - 1];
  check(lastMove?.method === 'PATCH' && lastMove?.path === '/api/v1/opportunities/op2/stage' && lastMove?.body?.stage === 'won', 'move_opportunity chama PATCH /api/v1/opportunities/op2/stage');
  check(moved.result?.isError === false && moved.result.content[0].text.includes('"probability": 100'), 'move_opportunity para won ajusta a probabilidade para 100');
  const lost = await tool('novacrm_move_opportunity', { id: 'op1', stage: 'lost', lossReason: 'preço' });
  const lastLost = apiCalls[apiCalls.length - 1];
  check(lastLost?.body?.lossReason === 'preço', 'move_opportunity para lost envia o motivo da perda');
  check(lost.result?.isError === false && lost.result.content[0].text.includes('"probability": 0'), 'move_opportunity para lost zera a probabilidade');
  const opportunityDeleted = await tool('novacrm_delete_opportunity', { id: 'op2' });
  const lastOpportunityDelete = apiCalls[apiCalls.length - 1];
  check(lastOpportunityDelete?.method === 'DELETE' && lastOpportunityDelete?.path === '/api/v1/opportunities/op2', 'delete_opportunity chama DELETE /api/v1/opportunities/op2');
  check(opportunityDeleted.result?.isError === false && opportunityDeleted.result.content[0].text.includes('"permanent": true'), 'delete_opportunity devolve o resultado da exclusão');

  // prompts
  const prompts = await call('prompts/list');
  check(prompts.result?.prompts?.length === 3, 'prompts/list devolve os 3 prompts prontos');
  const promptGet = await call('prompts/get', { name: 'resumo_diario_loja' });
  check(promptGet.result?.messages?.[0]?.content?.type === 'text', 'prompts/get devolve mensagem usável');
  const promptArgs = await call('prompts/get', { name: 'auditoria_estoque', arguments: { limite_alerta: 7 } });
  check(promptArgs.result?.messages?.[0]?.content?.text.includes('threshold=7'), 'prompt auditoria_estoque usa o argumento limite_alerta');
  const promptTrafego = await call('prompts/get', { name: 'analise_trafego_loja' });
  check(promptTrafego.result?.messages?.[0]?.content?.text.includes('novacrm_get_store_visits'), 'prompt analise_trafego_loja orienta usar a ferramenta de visitas');
  const promptBad = await call('prompts/get', { name: 'inexistente' });
  check(promptBad.error?.code === -32602, 'prompt inexistente devolve -32602');

  // lote JSON-RPC (batch legado)
  const batchIds = [900, 901];
  const batchDone = Promise.all(batchIds.map((id) => new Promise((resolve) => pending.set(id, resolve))));
  child.stdin.write(JSON.stringify([
    { jsonrpc: '2.0', id: 900, method: 'ping' },
    { jsonrpc: '2.0', id: 901, method: 'tools/list' },
  ]) + '\n');
  const batchResults = await batchDone;
  check(Array.isArray(batchResults) && batchResults.length === 2, 'batch de 2 requisições devolve 2 respostas');
  check(batchResults.every((r) => r.result), 'cada item do batch tem result próprio');

  // erros de protocolo
  child.stdin.write('isto não é json\n');
  await new Promise((r) => setTimeout(r, 300));
  check(protocolErrors.includes(-32700), 'linha inválida devolve parse error -32700');
  const badMethod = await call('resources/read', { uri: 'x' });
  check(badMethod.error?.code === -32601, 'método não suportado devolve -32601');
  const badTool = await tool('novacrm_nao_existe');
  check(badTool.result?.isError === true && badTool.result.content[0].text.includes('Ferramenta desconhecida'), 'ferramenta desconhecida devolve isError com mensagem clara');
  check(stderr.some((s) => s.includes('Servidor MCP ativo')), 'stderr anuncia a inicialização do servidor');

  // Sem chave configurada — aviso no stderr e erro claro nas ferramentas
  const childNoKey = spawn('node', [serverEntry], {
    env: { PATH: process.env.PATH, NOVACRM_BASE_URL: baseUrl },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const noKeyErr = [];
  childNoKey.stderr.on('data', (d) => noKeyErr.push(d.toString('utf8')));
  const noKeyOut = new Promise((resolve) => {
    const rl2 = readline.createInterface({ input: childNoKey.stdout, terminal: false });
    rl2.on('line', (l) => { if (l.trim()) resolve(JSON.parse(l)); });
  });
  childNoKey.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'novacrm_list_products' } }) + '\n');
  const noKeyResp = await noKeyOut;
  check(noKeyResp.result?.isError === true && noKeyResp.result.content[0].text.includes('NOVACRM_API_KEY'), 'sem chave: tools/call falha com instrução de configurar NOVACRM_API_KEY');
  check(noKeyErr.join('').includes('NOVACRM_API_KEY não definida'), 'sem chave: stderr avisa na inicialização');
  childNoKey.kill();
} finally {
  child.kill();
  apiServer.close();
}

console.log(`\nnovacrm-mcp: ${checks} checks verdes.`);
