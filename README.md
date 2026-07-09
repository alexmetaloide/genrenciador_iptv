# Clientes IPTV Legal

Sistema web responsivo para gerenciar clientes, planos, vencimentos, pagamentos, renovacoes e mensagens manuais de WhatsApp para um servico de IPTV legal/autorizado.

O app principal esta em `outputs/iptv-clientes`.

## Publicacao

O workflow `.github/workflows/deploy-pages.yml` publica automaticamente a pasta `outputs/iptv-clientes` no GitHub Pages quando houver push na branch `main`.

## Supabase

Rode `outputs/iptv-clientes/supabase-schema.sql` no SQL Editor do Supabase e depois informe no app:

- Project URL
- anon public key

Para deixar o app online ja conectado ao Supabase, preencha `outputs/iptv-clientes/supabase-config.js` com esses dois valores e envie para o GitHub.

Nunca publique a `service_role key`; use apenas a `anon public key`.
