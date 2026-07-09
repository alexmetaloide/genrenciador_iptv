# Clientes IPTV Legal

App web responsivo para gerenciamento de clientes, planos, vencimentos, pagamentos, renovacoes e mensagens manuais de WhatsApp.

## Como usar localmente

Abra `index.html` no navegador.

Sem Supabase configurado, o app funciona em modo local usando o armazenamento do proprio navegador.

## Como usar com Supabase

1. Crie um projeto no Supabase.
2. Abra o SQL Editor do Supabase.
3. Rode o arquivo `supabase-schema.sql`.
4. No Supabase, copie:
   - Project URL
   - anon public key
5. Abra o app.
6. Na tela inicial ou em Ajustes > Supabase, informe a URL e a anon key.
7. Crie uma conta por e-mail e senha.

Com Supabase ativo, os dados ficam no banco PostgreSQL e podem ser usados no celular e no computador com o mesmo login.

## O que esta pronto

- Login local ou login via Supabase Auth.
- Cadastro, edicao e cancelamento de clientes.
- Cadastro, edicao, desativacao e exclusao de planos.
- Dashboard com clientes ativos, vencidos, cancelados, testes, receita recebida e receita prevista.
- Tela de vencimentos: hoje, 3 dias, 5 dias, 7 dias e vencidos.
- Renovacao de cliente com registro de pagamento e atualizacao automatica do vencimento.
- Controle financeiro com pagamentos recebidos e pendentes.
- Historico de pagamentos por cliente.
- Mensagens manuais para WhatsApp: vencimento hoje, vencido, confirmacao e renovacao.
- Modelos de mensagem editaveis.
- Busca por nome, telefone e e-mail.
- Filtros por status, plano e vencimento.
- Relatorios por periodo.
- Exportacao CSV de clientes, pagamentos, relatorios e historico.
- Backup e importacao em JSON.
- Historico de alteracoes importantes.
- Modo responsivo para celular e computador.
- Deploy preparado para GitHub Pages.

## GitHub Pages

Este repositorio inclui o workflow `.github/workflows/deploy-pages.yml`.

Quando os arquivos forem enviados para a branch `main`, o GitHub Actions publica a pasta `outputs/iptv-clientes` no GitHub Pages.

Depois do primeiro push:

1. Abra Settings do repositorio.
2. Entre em Pages.
3. Em Source, escolha GitHub Actions.
4. Aguarde a action `Deploy IPTV Clientes`.

## WhatsApp

O WhatsApp esta em modo manual. O app gera a mensagem e abre a conversa, mas nao envia cobranca automatica.

## Observacao de seguranca

A anon public key do Supabase pode ficar no frontend quando as politicas RLS estao ativadas. O arquivo `supabase-schema.sql` ja cria politicas para cada usuario acessar apenas seus proprios dados.
