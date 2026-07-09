# Clientes IPTV Legal

Sistema web responsivo para gerenciar clientes, planos, vencimentos, pagamentos, renovacoes e mensagens manuais de WhatsApp para um servico de IPTV legal/autorizado.

O app principal esta em `outputs/iptv-clientes`.

## Publicacao

O workflow `.github/workflows/deploy-pages.yml` publica automaticamente a pasta `outputs/iptv-clientes` no GitHub Pages quando houver push na branch `main`.

## Supabase

Rode `outputs/iptv-clientes/supabase-schema.sql` no SQL Editor do Supabase e depois informe no app:

- Project URL
- anon public key

O app tambem continua funcionando em modo local se o Supabase ainda nao estiver configurado.
