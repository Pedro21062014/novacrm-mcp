# novacrm-mcp

Servidor **MCP (Model Context Protocol)** oficial do **NovaCRM**. Conecta IAs
como **Claude Desktop, Cursor, Claude Code, Gemini CLI, Zed e Cline** aos dados
e operações da sua loja — clientes, produtos, estoque, pedidos, cupons,
**automações, tarefas, propostas, pipeline de vendas**, webhooks e métricas —
tudo através da **API pública v1** do NovaCRM, autenticado pela chave de API
da loja.

- **Zero dependências**: JSON-RPC 2.0 sobre STDIO implementado na mão (Node ≥ 18).
- **50 ferramentas** cobrindo o dia a dia da loja + **3 prompts prontos**.
- **Escopos respeitados**: a chave define o que a IA pode fazer (leitura e/ou
  escrita), e os limites do plano e o rate limit valem normalmente.

```
┌──────────────┐   JSON-RPC/STDIO   ┌──────────────┐   HTTPS Bearer   ┌─────────────────┐
│  IA (Claude, │ ─────────────────▶ │ novacrm-mcp  │ ───────────────▶ │  API v1 do      │
│  Cursor, …)  │ ◀───────────────── │  (npx)       │ ◀─────────────── │  NovaCRM        │
└──────────────┘                    └──────────────┘                  └─────────────────┘
```

## Instalação e uso rápido

```bash
# direto, sem instalar nada
NOVACRM_API_KEY="ncrm_live.suachave" npx novacrm-mcp

# ou instalando globalmente
npm install -g novacrm-mcp
NOVACRM_API_KEY="ncrm_live.suachave" novacrm-mcp
```

Gere sua chave em **Console da API → Chaves de API** no painel do NovaCRM
(produção `ncrm_live.…` ou sandbox `ncrm_test.…`). A chave só é exibida na
criação.

> A chave define o que a IA pode fazer pelos **escopos** (ex.: `products:read`,
> `orders:write`). Crie uma chave enxuta se a IA só vai ler, e uma com escopos
> de escrita apenas quando confiar no agente.

## Configuração por cliente

### Claude Desktop

Edite `claude_desktop_config.json`
(`~/Library/Application Support/Claude/claude_desktop_config.json` no macOS,
`%APPDATA%\Claude\claude_desktop_config.json` no Windows):

```json
{
  "mcpServers": {
    "novacrm": {
      "command": "npx",
      "args": ["novacrm-mcp"],
      "env": {
        "NOVACRM_API_KEY": "ncrm_live.suachave.aqui"
      }
    }
  }
}
```

Reinicie o Claude Desktop — o martelinho 🔨 aparecerá com as ferramentas
`novacrm_*` disponíveis.

### Cursor

Crie `.cursor/mcp.json` no projeto (ou configure em Settings → MCP):

```json
{
  "mcpServers": {
    "novacrm": {
      "command": "npx",
      "args": ["novacrm-mcp"],
      "env": {
        "NOVACRM_API_KEY": "ncrm_live.suachave.aqui"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add novacrm -e NOVACRM_API_KEY=ncrm_live.suachave.aqui -- npx novacrm-mcp
```

### Gemini CLI

Adicione ao `settings.json` do Gemini CLI:

```json
{
  "mcpServers": {
    "novacrm": {
      "command": "npx",
      "args": ["novacrm-mcp"],
      "env": { "NOVACRM_API_KEY": "ncrm_live.suachave.aqui" },
      "timeout": 15000
    }
  }
}
```

### Zed, Cline e outros

Qualquer cliente MCP com transporte STDIO funciona: aponte o comando para
`npx novacrm-mcp` com a variável `NOVACRM_API_KEY`.

## Ferramentas disponíveis (50)

| Grupo | Ferramentas |
| --- | --- |
| Diagnóstico | `novacrm_ping` |
| Métricas | `novacrm_get_metrics` (overview / revenue / orders / products / clients / inventory / visits) |
| Visitas | `novacrm_get_store_visits` (visitantes únicos, produtos mais vistos, dispositivos, origem do tráfego — 30 dias) |
| Clientes | `novacrm_list_clients`, `novacrm_get_client`, `novacrm_create_client`, `novacrm_update_client`, `novacrm_import_clients` |
| Produtos | `novacrm_list_products`, `novacrm_get_product`, `novacrm_create_product`, `novacrm_update_product`, `novacrm_delete_product` |
| Estoque | `novacrm_inventory_alerts`, `novacrm_adjust_stock` |
| Pedidos | `novacrm_list_orders`, `novacrm_get_order`, `novacrm_create_order`, `novacrm_update_order_status`, `novacrm_cancel_order` |
| Cupons | `novacrm_list_coupons`, `novacrm_create_coupon`, `novacrm_validate_coupon` |
| Automações | `novacrm_list_automations`, `novacrm_get_automation`, `novacrm_create_automation`, `novacrm_update_automation`, `novacrm_delete_automation` |
| Tarefas | `novacrm_list_tasks`, `novacrm_get_task`, `novacrm_create_task`, `novacrm_update_task`, `novacrm_complete_task`, `novacrm_delete_task` |
| Propostas | `novacrm_list_proposals`, `novacrm_get_proposal`, `novacrm_create_proposal`, `novacrm_update_proposal`, `novacrm_delete_proposal` |
| Pipeline | `novacrm_list_opportunities`, `novacrm_get_opportunity`, `novacrm_create_opportunity`, `novacrm_move_opportunity`, `novacrm_update_opportunity`, `novacrm_delete_opportunity` |
| Loja | `novacrm_get_store`, `novacrm_update_store`, `novacrm_set_store_status` |
| Webhooks | `novacrm_list_webhooks`, `novacrm_create_webhook` |

Status de pedido válidos: `pending_payment`, `new`, `processing`,
`completed`, `cancelled`. Gatilhos de automação: `client_created`,
`order_created`, `order_paid`, `proposal_approved`, `opportunity_won`,
`inactive_client_30d`. Estágios do pipeline: `lead`, `contact`, `proposal`,
`negotiation`, `won`, `lost`. Status de proposta: `draft`, `sent`, `viewed`,
`approved`, `rejected`.

## Prompts prontos

- `resumo_diario_loja` — briefing executivo da loja (faturamento, pedidos
  pendentes e alertas de estoque).
- `auditoria_estoque` — auditoria do catálogo com plano de reposição
  (aceita `limite_alerta`).
- `analise_trafego_loja` — análise de tráfego da loja pública: visitantes,
  origens, dispositivos, produtos mais vistos e taxa de checkout com
  recomendações de conversão.

## Variáveis de ambiente

| Variável | Obrigatória | Padrão |
| --- | --- | --- |
| `NOVACRM_API_KEY` | sim | — |
| `NOVACRM_BASE_URL` | não | `https://console.novacrm.com.br/api/v1` |

Para apontar para o sandbox: `NOVACRM_BASE_URL=https://sandbox.novacrm.com.br/api/v1`
com uma chave `ncrm_test.…`.

## Segurança

- A chave trafega apenas no header `Authorization` da API (no STDIO fica na
  variável de ambiente do processo local, nunca sai da sua máquina).
- Toda chamada passa pelo **rate limit por chave** e pelos **limites do plano**
  (Free 100/mês, Pro 10.000/mês, Enterprise 100.000/mês).
- **Escopos por ferramenta**: uma chave sem `orders:write` nunca cancela um
  pedido, mesmo que a IA tente. Deletar definitivamente exige o escopo
  `dangerous:delete`.
- **Zero dependências npm**: nada para instalar ou vulnerabilizar.

## Desenvolvimento

Sem etapa de build — o servidor é um único arquivo ESM:

```bash
git clone https://github.com/Pedro21062014/novacrm-mcp.git
cd novacrm-mcp
node test/e2e.mjs   # suíte e2e: sobe uma API v1 simulada e valida o servidor
```

O teste valida o protocolo completo (initialize, tools/list, tools/call de
leitura e escrita, prompts, erros, lote JSON-RPC e execução sem chave).

## Licença

[MIT](./LICENSE) © NovaCRM
