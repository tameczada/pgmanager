# 🐘 PGManager — Deploy no Render

## Estrutura do projeto

```
pgmanager/
├── render.yaml              ← Blueprint do Render (deploy automático)
├── .gitignore
├── backend/
│   ├── server.js
│   ├── package.json         ← com "engines": node >=18
│   └── .env.example
└── frontend/
    └── public/
        └── index.html
```

---

## Passo a passo

### 1. Suba para o GitHub

```bash
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/pgmanager.git
git push -u origin main
```

### 2. Deploy no Render via Blueprint

1. Acesse **dashboard.render.com**
2. Clique em **New → Blueprint**
3. Conecte seu repositório `pgmanager`
4. O Render vai detectar o `render.yaml` automaticamente
5. Clique **Apply** — o deploy começa sozinho

### 3. Acesse o app

Após ~2 minutos o Render vai te dar uma URL:
```
https://pgmanager.onrender.com
```

---

## Observações

- **Cold start**: no plano free o app "dorme" após 15min sem uso.
  A próxima visita pode demorar ~20s para acordar.
- **Conexões**: você conecta ao banco pelo formulário do app.
  Não é necessário configurar variáveis de ambiente.
- **Segurança**: o app não tem login. Use apenas localmente ou não divulgue a URL.
