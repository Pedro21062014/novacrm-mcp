#!/usr/bin/env node

/**
 * novacrm-mcp — Servidor MCP oficial (Model Context Protocol) do NovaCRM
 *
 * Repositório próprio: https://github.com/Pedro21062014/novacrm-mcp
 * Pacote npm: novacrm-mcp (zero dependências)
 *
 * Conecta clientes MCP (Claude Desktop, Cursor, Claude Code, Gemini CLI, Zed,
 * Cline, etc.) aos dados e operações da sua loja no NovaCRM através da
 * API pública v1 (Bearer API key).
 *
 * Implementação 100% sem dependências: JSON-RPC 2.0 sobre STDIO na mão,
 * compatível com a especificação MCP (protocolo 2024-11-05).
 *
 * Configuração (variáveis de ambiente):
 *   NOVACRM_API_KEY    Chave de API da loja (ncrm_live.… ou ncrm_test.…) — obrigatória
 *   NOVACRM_BASE_URL   URL base da API (padrão: https://console.novacrm.com.br/api/v1)
 *
 * Uso:
 *   npx novacrm-mcp
 *   NOVACRM_API_KEY=ncrm_live.xxx npx novacrm-mcp
 *   node index.mjs   (executando a partir do clone do repositório)
 */

import readline from 'node:readline';

const API_KEY = process.env.NOVACRM_API_KEY || '';
const BASE_URL = (process.env.NOVACRM_BASE_URL || 'https://console.novacrm.com.br/api/v1').replace(/\/+$/, '');

const SERVER_NAME = 'novacrm-mcp-server';
const SERVER_VERSION = '1.1.0';
const PROTOCOL_VERSION = '2024-11-05';

const ORDER_STATUSES = ['pending_payment', 'new', 'processing', 'completed', 'cancelled'];
const WEBHOOK_EVENTS = ['client.created', 'client.updated', 'client.deleted', 'product.created', 'product.updated', 'product.deleted', 'inventory.adjusted', 'inventory.low', 'order.created', 'order.status_updated', 'order.cancelled', '*'];

// ---------------------------------------------------------------- HTTP ----

async function callNovaCrmApi(path, options = {}) {
  if (!API_KEY) {
    throw new Error('Chave de API não configurada. Defina a variável de ambiente NOVACRM_API_KEY (gere uma chave no Console da API do NovaCRM).');
  }

  const url = `${BASE_URL}${path.startsWith('/') ? path : '/' + path}`;
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': `NovaCRM-MCP-Server/${SERVER_VERSION}`,
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const contentType = response.headers.get('content-type') || '';
  let data;
  if (contentType.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  // Envelope da API v1: { success, data, meta } | { success:false, error }
  if (!response.ok || (typeof data === 'object' && data && data.success === false)) {
    const err = typeof data === 'object' && data ? data.error : null;
    const message = err ? `${err.code || 'error'}: ${err.message || 'erro desconhecido'}` : `HTTP ${response.status}: ${response.statusText}`;
    const error = new Error(`Erro na API NovaCRM (${response.status}) — ${message}`);
    error.statusCode = response.status;
    error.apiCode = err?.code;
    throw error;
  }

  if (typeof data === 'object' && data && data.success === true) {
    return { data: data.data, meta: data.meta };
  }
  return { data, meta: null };
}

// -------------------------------------------------------------- Catálogo --

function tool(name, description, properties = {}, required = []) {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

const TOOLS = [
  tool('novacrm_ping',
    'Testa a conectividade e a autenticação da chave de API com o NovaCRM. Use antes de qualquer outra ferramenta para validar a configuração.',
    {},
    []),

  tool('novacrm_get_metrics',
    'Resumo analítico da loja: faturamento pago, ticket médio, pedidos por status, total de clientes e produtos.',
    {
      detail: { type: 'string', enum: ['overview', 'revenue', 'orders', 'products', 'clients', 'inventory'], description: 'Visão detalhada opcional: revenue (faturamento), orders (pedidos por status), products (mais vendidos e estoque baixo), clients (top clientes por LTV), inventory (unidades totais e faltando)' },
    },
    []),

  tool('novacrm_list_clients',
    'Lista clientes da loja com paginação.',
    {
      limit: { type: 'number', description: 'Itens por página (1–100, padrão 50)' },
      offset: { type: 'number', description: 'Deslocamento da paginação (padrão 0)' },
      includeArchived: { type: 'boolean', description: 'Incluir clientes arquivados (padrão false)' },
    },
    []),

  tool('novacrm_get_client',
    'Obtém os detalhes de um cliente específico pelo ID.',
    { id: { type: 'string', description: 'ID do cliente' } },
    ['id']),

  tool('novacrm_create_client',
    'Cadastra um novo cliente na loja.',
    {
      name: { type: 'string', description: 'Nome completo do cliente' },
      phone: { type: 'string', description: 'Telefone com DDD (ex: 11987654321)' },
      email: { type: 'string', description: 'E-mail do cliente' },
      clientType: { type: 'string', description: 'Tipo/categoria do cliente' },
      status: { type: 'string', description: 'Status comercial do cliente' },
      address: { type: 'object', description: 'Endereço do cliente' },
      notes: { type: 'string', description: 'Observações internas' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Etiquetas do cliente' },
    },
    ['name']),

  tool('novacrm_update_client',
    'Atualiza dados de um cliente existente (envie apenas os campos a alterar).',
    {
      id: { type: 'string', description: 'ID do cliente' },
      name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' },
      clientType: { type: 'string' }, status: { type: 'string' },
      address: { type: 'object' }, notes: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
    },
    ['id']),

  tool('novacrm_import_clients',
    'Importa clientes em lote (até 500 por chamada) — ideal para migração de dados de outro sistema.',
    {
      records: {
        type: 'array',
        description: 'Lista de clientes a importar (mesmos campos do create_client)',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Nome completo' },
            phone: { type: 'string' }, email: { type: 'string' },
            clientType: { type: 'string' }, status: { type: 'string' },
            address: { type: 'object' }, notes: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    ['records']),

  tool('novacrm_list_products',
    'Lista produtos do catálogo da loja com paginação.',
    {
      limit: { type: 'number', description: 'Itens por página (1–100, padrão 50)' },
      offset: { type: 'number', description: 'Deslocamento da paginação (padrão 0)' },
      includeArchived: { type: 'boolean', description: 'Incluir produtos arquivados (padrão false)' },
    },
    []),

  tool('novacrm_get_product',
    'Obtém os detalhes de um produto específico pelo ID.',
    { id: { type: 'string', description: 'ID do produto' } },
    ['id']),

  tool('novacrm_create_product',
    'Cadastra um novo produto no catálogo da loja.',
    {
      name: { type: 'string', description: 'Nome do produto' },
      price: { type: 'number', description: 'Preço em Reais (ex: 49.9)' },
      stock: { type: 'number', description: 'Quantidade inicial em estoque (padrão 0)' },
      category: { type: 'string', description: 'Categoria do produto' },
      description: { type: 'string', description: 'Descrição exibida na vitrine' },
      imageUrl: { type: 'string', description: 'URL da imagem do produto' },
    },
    ['name', 'price']),

  tool('novacrm_update_product',
    'Atualiza dados, preço ou estoque de um produto existente (envie apenas os campos a alterar).',
    {
      id: { type: 'string', description: 'ID do produto' },
      name: { type: 'string' }, price: { type: 'number' }, stock: { type: 'number' },
      category: { type: 'string' }, description: { type: 'string' }, imageUrl: { type: 'string' },
    },
    ['id']),

  tool('novacrm_delete_product',
    'Remove um produto do catálogo. Por padrão arquiva (reversível); com permanent=true exclui definitivamente (exige escopo dangerous:delete).',
    {
      id: { type: 'string', description: 'ID do produto' },
      permanent: { type: 'boolean', description: 'Excluir definitivamente em vez de arquivar (padrão false)' },
    },
    ['id']),

  tool('novacrm_inventory_alerts',
    'Lista produtos em estoque baixo (abaixo do limite informado ou de 5 unidades).',
    { threshold: { type: 'number', description: 'Limite de estoque considerado crítico (padrão 5)' } },
    []),

  tool('novacrm_adjust_stock',
    'Ajusta o estoque de um produto com registro de movimentação (entrada/saída).',
    {
      productId: { type: 'string', description: 'ID do produto' },
      quantityDelta: { type: 'number', description: 'Variação de estoque: positivo soma (entrada), negativo subtrai (saída). Nunca 0.' },
      reason: { type: 'string', description: 'Motivo do ajuste (ex: reposição, correção de inventário)' },
      lowStockThreshold: { type: 'number', description: 'Limite para disparar alerta de estoque baixo (padrão 5)' },
    },
    ['productId', 'quantityDelta']),

  tool('novacrm_list_orders',
    'Lista pedidos da loja, com filtro opcional por status e paginação.',
    {
      status: { type: 'string', enum: ORDER_STATUSES, description: 'Filtrar por status: pending_payment | new | processing | completed | cancelled' },
      limit: { type: 'number', description: 'Itens por página (1–100, padrão 50)' },
      offset: { type: 'number', description: 'Deslocamento da paginação (padrão 0)' },
    },
    []),

  tool('novacrm_get_order',
    'Obtém os detalhes de um pedido específico (itens, cliente, endereço e pagamento).',
    { id: { type: 'string', description: 'ID do pedido' } },
    ['id']),

  tool('novacrm_create_order',
    'Registra um novo pedido para a loja.',
    {
      customerName: { type: 'string', description: 'Nome do cliente do pedido' },
      items: {
        type: 'array',
        description: 'Itens do pedido',
        items: {
          type: 'object',
          properties: {
            productId: { type: 'string', description: 'ID do produto (quando existir no catálogo)' },
            productName: { type: 'string', description: 'Nome do produto/serviço' },
            price: { type: 'number', description: 'Preço unitário em Reais' },
            quantity: { type: 'number', description: 'Quantidade (padrão 1)' },
          },
        },
      },
      notes: { type: 'string', description: 'Observações do pedido' },
      deliveryAddress: { type: 'object', description: 'Endereço de entrega' },
      status: { type: 'string', enum: ORDER_STATUSES, description: 'Status inicial (padrão new)' },
    },
    ['customerName', 'items']),

  tool('novacrm_update_order_status',
    'Atualiza o status de um pedido (ex.: marcar como pago, em processamento ou concluído).',
    {
      id: { type: 'string', description: 'ID do pedido' },
      status: { type: 'string', enum: ORDER_STATUSES, description: 'Novo status' },
    },
    ['id', 'status']),

  tool('novacrm_cancel_order',
    'Cancela um pedido informando o motivo.',
    {
      id: { type: 'string', description: 'ID do pedido' },
      reason: { type: 'string', description: 'Motivo do cancelamento' },
    },
    ['id']),

  tool('novacrm_list_coupons',
    'Lista os cupons de desconto da loja.',
    {},
    []),

  tool('novacrm_create_coupon',
    'Cria um cupom de desconto.',
    {
      code: { type: 'string', description: 'Código do cupom (ex: BEMVINDO10)' },
      type: { type: 'string', enum: ['fixed', 'percentage'], description: 'fixed = valor fixo em Reais; percentage = percentual' },
      value: { type: 'number', description: 'Valor do desconto (Reais ou %, conforme o tipo)' },
      minPurchase: { type: 'number', description: 'Valor mínimo de compra (padrão 0)' },
    },
    ['code', 'type', 'value']),

  tool('novacrm_validate_coupon',
    'Valida um cupom para um determinado subtotal e calcula o desconto.',
    {
      code: { type: 'string', description: 'Código do cupom' },
      subtotal: { type: 'number', description: 'Subtotal do pedido em Reais' },
      items: { type: 'array', items: { type: 'object' }, description: 'Itens do pedido (opcional)' },
    },
    ['code', 'subtotal']),

  tool('novacrm_get_store',
    'Obtém as informações públicas da loja (nome, descrição, WhatsApp, tema, horários).',
    {},
    []),

  tool('novacrm_update_store',
    'Atualiza informações da loja (envie apenas os campos a alterar).',
    {
      storeName: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' },
      whatsapp: { type: 'string' }, themeColor: { type: 'string', description: 'Cor de destaque (ex: #4f46e5)' },
      logoUrl: { type: 'string' }, bannerUrl: { type: 'string' }, openingHours: { type: 'object' },
    },
    []),

  tool('novacrm_set_store_status',
    'Abre/fecha a loja ou publica/despublica a vitrine.',
    {
      isOpen: { type: 'boolean', description: 'Loja aberta para pedidos?' },
      isPublished: { type: 'boolean', description: 'Vitrine publicada no marketplace?' },
    },
    []),

  tool('novacrm_list_webhooks',
    'Lista os webhooks configurados na loja.',
    {},
    []),

  tool('novacrm_create_webhook',
    'Cria um webhook para receber notificações de eventos da loja em uma URL HTTPS. O signing secret é exibido apenas uma vez na resposta.',
    {
      name: { type: 'string', description: 'Nome do webhook' },
      url: { type: 'string', description: 'URL HTTPS que receberá os eventos (POST)' },
      events: { type: 'array', items: { type: 'string', enum: WEBHOOK_EVENTS }, description: 'Eventos assinados (use * para todos)' },
    },
    ['url', 'events']),
];

// ------------------------------------------------------------- Prompts ----

const PROMPTS = [
  {
    name: 'resumo_diario_loja',
    description: 'Briefing executivo da loja: faturamento, pedidos pendentes e alertas de estoque.',
    arguments: [],
  },
  {
    name: 'auditoria_estoque',
    description: 'Audita o catálogo e identifica produtos esgotados ou com estoque crítico, com plano de reposição.',
    arguments: [
      { name: 'limite_alerta', description: 'Estoque mínimo considerado crítico (padrão 5)', required: false },
    ],
  },
];

function promptMessages(name, args = {}) {
  if (name === 'resumo_diario_loja') {
    return {
      description: 'Briefing diário da loja NovaCRM',
      messages: [{
        role: 'user',
        content: { type: 'text', text: 'Use as ferramentas do NovaCRM (novacrm_get_metrics e novacrm_list_orders) e monte um briefing executivo: faturamento e ticket médio, pedidos pendentes de pagamento/em processamento, e conclusões práticas para hoje.' },
      }],
    };
  }
  if (name === 'auditoria_estoque') {
    const limite = Number(args.limite_alerta) || 5;
    return {
      description: 'Auditoria de estoque do catálogo NovaCRM',
      messages: [{
        role: 'user',
        content: { type: 'text', text: `Use novacrm_inventory_alerts com threshold=${limite} e novacrm_list_products, identifique produtos esgotados e com estoque abaixo de ${limite} unidades e elabore um plano de reposição prioritário.` },
      }],
    };
  }
  return null;
}

// ---------------------------------------------------------- Execução ------

function qs(params) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  });
  const str = search.toString();
  return str ? `?${str}` : '';
}

async function executeTool(name, args = {}) {
  switch (name) {
    case 'novacrm_ping': {
      const keyEnv = API_KEY.startsWith('ncrm_test') ? 'sandbox' : (API_KEY.startsWith('ncrm_live') ? 'production' : 'desconhecido');
      try {
        await callNovaCrmApi('/analytics');
        return { status: 'connected', message: 'Conexão com a API do NovaCRM estabelecida e autenticada com sucesso.', apiBase: BASE_URL, environment: keyEnv };
      } catch (err) {
        return { status: 'error', message: 'Não foi possível autenticar na API do NovaCRM.', apiBase: BASE_URL, environment: keyEnv, detail: err.message };
      }
    }

    case 'novacrm_get_metrics': {
      const path = args.detail && args.detail !== 'overview' ? `/analytics/${encodeURIComponent(args.detail)}` : '/analytics';
      const { data, meta } = await callNovaCrmApi(path);
      return { analytics: data, meta };
    }

    case 'novacrm_list_clients': {
      const { data, meta } = await callNovaCrmApi(`/clients${qs({ limit: args.limit, offset: args.offset, includeArchived: args.includeArchived })}`);
      return { clients: data?.clients ?? [], pagination: meta?.pagination ?? null };
    }

    case 'novacrm_get_client': {
      const { data } = await callNovaCrmApi(`/clients/${encodeURIComponent(args.id)}`);
      return data?.client ?? data;
    }

    case 'novacrm_create_client': {
      const { data } = await callNovaCrmApi('/clients', { method: 'POST', body: args });
      return data?.client ?? data;
    }

    case 'novacrm_update_client': {
      const { id, ...updates } = args;
      const { data } = await callNovaCrmApi(`/clients/${encodeURIComponent(id)}`, { method: 'PATCH', body: updates });
      return data?.client ?? data;
    }

    case 'novacrm_import_clients': {
      const { data } = await callNovaCrmApi('/imports/clients', {
        method: 'POST',
        body: { records: Array.isArray(args.records) ? args.records.slice(0, 500) : [] },
      });
      return data?.import ?? data;
    }

    case 'novacrm_list_products': {
      const { data, meta } = await callNovaCrmApi(`/products${qs({ limit: args.limit, offset: args.offset, includeArchived: args.includeArchived })}`);
      return { products: data?.products ?? [], pagination: meta?.pagination ?? null };
    }

    case 'novacrm_get_product': {
      const { data } = await callNovaCrmApi(`/products/${encodeURIComponent(args.id)}`);
      return data?.product ?? data;
    }

    case 'novacrm_create_product': {
      const { data } = await callNovaCrmApi('/products', { method: 'POST', body: args });
      return data?.product ?? data;
    }

    case 'novacrm_update_product': {
      const { id, ...updates } = args;
      const { data } = await callNovaCrmApi(`/products/${encodeURIComponent(id)}`, { method: 'PATCH', body: updates });
      return data?.product ?? data;
    }

    case 'novacrm_delete_product': {
      const { data } = await callNovaCrmApi(`/products/${encodeURIComponent(args.id)}${qs({ permanent: args.permanent === true ? 'true' : undefined })}`, { method: 'DELETE' });
      return data ?? { deleted: args.id };
    }

    case 'novacrm_inventory_alerts': {
      const { data } = await callNovaCrmApi(`/inventory/alerts${qs({ threshold: args.threshold })}`);
      return data;
    }

    case 'novacrm_adjust_stock': {
      const { data } = await callNovaCrmApi('/inventory/adjustments', {
        method: 'POST',
        body: { productId: args.productId, quantityDelta: Number(args.quantityDelta), reason: args.reason, lowStockThreshold: args.lowStockThreshold },
      });
      return data?.adjustment ?? data;
    }

    case 'novacrm_list_orders': {
      const { data, meta } = await callNovaCrmApi(`/orders${qs({ status: args.status, limit: args.limit, offset: args.offset })}`);
      return { orders: data?.orders ?? [], pagination: meta?.pagination ?? null };
    }

    case 'novacrm_get_order': {
      const { data } = await callNovaCrmApi(`/orders/${encodeURIComponent(args.id)}`);
      return data?.order ?? data;
    }

    case 'novacrm_create_order': {
      const { data } = await callNovaCrmApi('/orders', {
        method: 'POST',
        body: {
          customerName: args.customerName,
          items: Array.isArray(args.items) ? args.items : [],
          notes: args.notes,
          deliveryAddress: args.deliveryAddress,
          status: args.status,
        },
      });
      return data?.order ?? data;
    }

    case 'novacrm_update_order_status': {
      const { data } = await callNovaCrmApi(`/orders/${encodeURIComponent(args.id)}/status`, { method: 'PATCH', body: { status: args.status } });
      return data?.order ?? data;
    }

    case 'novacrm_cancel_order': {
      const { data } = await callNovaCrmApi(`/orders/${encodeURIComponent(args.id)}/cancel`, { method: 'POST', body: { reason: args.reason } });
      return data?.order ?? data;
    }

    case 'novacrm_list_coupons': {
      const { data } = await callNovaCrmApi('/coupons');
      return { coupons: data?.coupons ?? [] };
    }

    case 'novacrm_create_coupon': {
      const { data } = await callNovaCrmApi('/coupons', { method: 'POST', body: args });
      return data?.coupon ?? data;
    }

    case 'novacrm_validate_coupon': {
      const { data } = await callNovaCrmApi('/coupons/validate', { method: 'POST', body: { code: args.code, subtotal: Number(args.subtotal), items: args.items } });
      return data;
    }

    case 'novacrm_get_store': {
      const { data } = await callNovaCrmApi('/store');
      return data?.store ?? data;
    }

    case 'novacrm_update_store': {
      const { data } = await callNovaCrmApi('/store', { method: 'PATCH', body: args });
      return data?.store ?? data;
    }

    case 'novacrm_set_store_status': {
      const { data } = await callNovaCrmApi('/store/status', { method: 'PATCH', body: { isOpen: args.isOpen, isPublished: args.isPublished } });
      return data?.status ?? data;
    }

    case 'novacrm_list_webhooks': {
      const { data } = await callNovaCrmApi('/webhooks');
      return { webhooks: data?.webhooks ?? [] };
    }

    case 'novacrm_create_webhook': {
      const { data } = await callNovaCrmApi('/webhooks', { method: 'POST', body: { name: args.name, url: args.url, events: Array.isArray(args.events) ? args.events : [] } });
      return data?.webhook ?? data;
    }

    default:
      throw new Error(`Ferramenta desconhecida: ${name}`);
  }
}

// ------------------------------------------------------------ JSON-RPC ----

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleRpcRequest(request) {
  const { id, method, params } = request || {};

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          prompts: { listChanged: false },
        },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: 'Servidor MCP oficial do NovaCRM. Chame novacrm_ping para validar a conexão. As ferramentas operam sobre a API v1 da loja autenticada pela chave NOVACRM_API_KEY.',
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // notificações não recebem resposta

    case 'ping':
      return rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });

    case 'tools/call': {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const output = await executeTool(toolName, toolArgs);
        return rpcResult(id, {
          content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output, null, 2) }],
          isError: false,
        });
      } catch (err) {
        return rpcResult(id, {
          content: [{ type: 'text', text: `Erro ao executar ${toolName}: ${err.message}` }],
          isError: true,
        });
      }
    }

    case 'prompts/list':
      return rpcResult(id, { prompts: PROMPTS });

    case 'prompts/get': {
      const built = promptMessages(params?.name, params?.arguments || {});
      if (!built) return rpcError(id, -32602, `Prompt não encontrado: ${params?.name}`);
      return rpcResult(id, built);
    }

    default:
      return rpcError(id, -32601, `Método não suportado: ${method}`);
  }
}

// -------------------------------------------------------------- STDIO -----

function startStdioServer() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let response;
    try {
      const request = JSON.parse(trimmed);
      if (request && Array.isArray(request)) {
        // Batch JSON-RPC (legado): responde cada requisição individualmente.
        const responses = [];
        for (const item of request) {
          const r = await handleRpcRequest(item);
          if (r) responses.push(r);
        }
        response = responses.length ? responses : null;
      } else {
        response = await handleRpcRequest(request);
      }
    } catch (parseErr) {
      response = rpcError(null, -32700, `Parse error: ${parseErr.message}`);
    }
    if (response) process.stdout.write(JSON.stringify(response) + '\n');
  });

  rl.on('close', () => process.exit(0));

  if (!API_KEY) {
    process.stderr.write('[NovaCRM-MCP] ATENÇÃO: variável NOVACRM_API_KEY não definida — as ferramentas vão falhar até que uma chave seja configurada.\n');
  }
  process.stderr.write(`[NovaCRM-MCP] Servidor MCP ativo em STDIO (v${SERVER_VERSION}) → ${BASE_URL}\n`);
}

startStdioServer();
