/** novacrm-mcp — suíte e2e do servidor STDIO (sem dependências).
 *
 * Sobe uma API v1 simulada (envelope real { success, data, meta }), spawn o
 * servidor com node e fala JSON-RPC 2.0 pelo stdin/stdout:
 *
 *   - initialize (serverInfo, protocolVersion, capabilities)
 *   - notifications/initialized (sem resposta, sem chamada à API)
 *   - ping, tools/list (27 ferramentas, prefixo novacrm_, schemas)
 *   - tools/call de leitura (list_products com Bearer correto + paginação)
 *   - tools/call novacrm_ping (status connected, ambiente production)
 *   - tools/call de escrita (create_product, update_order_status com status REAL)
 *   - query params compostos (inventory_alerts com threshold)
 *   - list_clients com includeArchived, delete_product com permanent=true,
 *     get_metrics com detail=revenue
 *   - importação em lote (imports/clients)
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
  check(Array.isArray(catalog) && catalog.length === 27, `tools/list devolve 27 ferramentas (${catalog?.length})`);
  check(catalog.every((t) => t.name.startsWith('novacrm_')), 'todas as ferramentas têm o prefixo novacrm_');
  check(catalog.every((t) => t.inputSchema?.type === 'object'), 'todas as ferramentas têm inputSchema object');
  const requiredTool = catalog.find((t) => t.name === 'novacrm_create_product');
  check(JSON.stringify(requiredTool?.inputSchema?.required) === JSON.stringify(['name', 'price']), 'novacrm_create_product exige name e price');
  const statusTool = catalog.find((t) => t.name === 'novacrm_update_order_status');
  check(JSON.stringify(statusTool?.inputSchema?.properties?.status?.enum) === JSON.stringify(['pending_payment', 'new', 'processing', 'completed', 'cancelled']), 'status de pedido usa os valores REAIS da API v1');

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

  // prompts
  const prompts = await call('prompts/list');
  check(prompts.result?.prompts?.length === 2, 'prompts/list devolve os 2 prompts prontos');
  const promptGet = await call('prompts/get', { name: 'resumo_diario_loja' });
  check(promptGet.result?.messages?.[0]?.content?.type === 'text', 'prompts/get devolve mensagem usável');
  const promptArgs = await call('prompts/get', { name: 'auditoria_estoque', arguments: { limite_alerta: 7 } });
  check(promptArgs.result?.messages?.[0]?.content?.text.includes('threshold=7'), 'prompt auditoria_estoque usa o argumento limite_alerta');
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
