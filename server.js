const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Servir arquivos estáticos
app.use(express.static('public'));

// Estado do sistema
let sistemaAtivo = false;
let pedidos = [];
let proximoId = 1;

// Mapa de timers para poder cancelá-los se necessário
const timersExpiracao = new Map();

// Função auxiliar para limpar timer
function limparTimer(pedidoId) {
  if (timersExpiracao.has(pedidoId)) {
    clearTimeout(timersExpiracao.get(pedidoId));
    timersExpiracao.delete(pedidoId);
  }
}

// Evento: Cliente conecta ao servidor
io.on('connection', (socket) => {
  console.log('🔌 Novo cliente conectado:', socket.id);

  // Envia estado atual para o novo cliente
  socket.emit('estado.inicial', {
    sistemaAtivo,
    pedidos
  });

  // EVENTO 1: sistema.iniciar
  // Origem: Cliente (Admin)
  // Descrição: Administrador inicia o sistema de pedidos
  socket.on('sistema.iniciar', () => {
    console.log('📢 Sistema iniciado pelo admin');
    sistemaAtivo = true;
    
    // Emite para TODOS os clientes conectados
    io.emit('sistema.iniciado', {
      mensagem: 'Sistema de pedidos iniciado!',
      timestamp: new Date().toLocaleTimeString()
    });
  });

  // EVENTO 2: pedido.criar
  // Origem: Cliente
  // Descrição: Cliente cria um novo pedido
  socket.on('pedido.criar', (dados) => {
    if (!sistemaAtivo) {
      socket.emit('erro.operacao', { 
        mensagem: 'Sistema não está ativo!' 
      });
      return;
    }

    // Validação básica
    if (!dados.cliente || !dados.itens) {
      socket.emit('erro.operacao', { 
        mensagem: 'Dados inválidos! Cliente e itens são obrigatórios.' 
      });
      return;
    }

    // Cria novo pedido
    const novoPedido = {
      id: proximoId++,
      cliente: dados.cliente.trim(),
      itens: dados.itens.trim(),
      status: 'pendente',
      criadoEm: new Date().toLocaleTimeString(),
      socketId: socket.id
    };

    pedidos.push(novoPedido);
    console.log(`📝 Novo pedido criado: #${novoPedido.id} - ${novoPedido.cliente}`);

    // Emite para TODOS os clientes
    io.emit('pedido.criado', novoPedido);

    // Inicia timer de expiração (30 segundos)
    const timer = setTimeout(() => {
      const pedido = pedidos.find(p => p.id === novoPedido.id);
      if (pedido && pedido.status === 'pendente') {
        pedido.status = 'expirado';
        console.log(`⏰ Pedido #${pedido.id} expirou`);
        
        // Emite evento de expiração para todos
        io.emit('pedido.expirado', pedido);
        
        // Remove o timer do mapa
        timersExpiracao.delete(novoPedido.id);
      }
    }, 30000);

    // Armazena o timer para possível cancelamento
    timersExpiracao.set(novoPedido.id, timer);
  });

  // EVENTO 3: pedido.aceitar
  // Origem: Cliente (Admin/Cozinha)
  // Descrição: Cozinha aceita o pedido
  socket.on('pedido.aceitar', (pedidoId) => {
    const pedido = pedidos.find(p => p.id === pedidoId);
    
    if (!pedido) {
      socket.emit('erro.operacao', { 
        mensagem: 'Pedido não encontrado!' 
      });
      return;
    }

    if (pedido.status !== 'pendente') {
      socket.emit('erro.operacao', { 
        mensagem: 'Apenas pedidos pendentes podem ser aceitos!' 
      });
      return;
    }
    
    pedido.status = 'preparando';
    console.log(`✅ Pedido #${pedidoId} aceito pela cozinha`);
    
    // Cancela o timer de expiração
    limparTimer(pedidoId);
    
    // Emite para todos os clientes
    io.emit('pedido.aceito', pedido);
  });

  // EVENTO 4: pedido.finalizar
  // Origem: Cliente (Admin/Cozinha)
  // Descrição: Cozinha finaliza o preparo do pedido
  socket.on('pedido.finalizar', (pedidoId) => {
    const pedido = pedidos.find(p => p.id === pedidoId);
    
    if (!pedido) {
      socket.emit('erro.operacao', { 
        mensagem: 'Pedido não encontrado!' 
      });
      return;
    }

    if (pedido.status !== 'preparando') {
      socket.emit('erro.operacao', { 
        mensagem: 'Apenas pedidos em preparo podem ser finalizados!' 
      });
      return;
    }
    
    pedido.status = 'pronto';
    pedido.prontoEm = new Date().toLocaleTimeString();
    console.log(`🍽️ Pedido #${pedidoId} está pronto`);
    
    // Emite para todos os clientes
    io.emit('pedido.finalizado', pedido);
  });

  // EVENTO 5: pedido.cancelar
  // Origem: Cliente (Admin/Cozinha)
  // Descrição: Cancelamento de pedido
  socket.on('pedido.cancelar', (pedidoId) => {
    const pedido = pedidos.find(p => p.id === pedidoId);
    
    if (!pedido) {
      socket.emit('erro.operacao', { 
        mensagem: 'Pedido não encontrado!' 
      });
      return;
    }

    if (pedido.status === 'entregue' || pedido.status === 'cancelado') {
      socket.emit('erro.operacao', { 
        mensagem: 'Este pedido não pode ser cancelado!' 
      });
      return;
    }
    
    pedido.status = 'cancelado';
    pedido.canceladoEm = new Date().toLocaleTimeString();
    console.log(`❌ Pedido #${pedidoId} cancelado`);
    
    // Cancela o timer de expiração se existir
    limparTimer(pedidoId);
    
    // Emite para todos os clientes
    io.emit('pedido.cancelado', pedido);
  });

  // EVENTO 6: pedido.entregar
  // Origem: Cliente (Admin/Cozinha)
  // Descrição: Pedido é entregue ao cliente
  socket.on('pedido.entregar', (pedidoId) => {
    const pedido = pedidos.find(p => p.id === pedidoId);
    
    if (!pedido) {
      socket.emit('erro.operacao', { 
        mensagem: 'Pedido não encontrado!' 
      });
      return;
    }

    if (pedido.status !== 'pronto') {
      socket.emit('erro.operacao', { 
        mensagem: 'Apenas pedidos prontos podem ser entregues!' 
      });
      return;
    }
    
    pedido.status = 'entregue';
    pedido.entregueEm = new Date().toLocaleTimeString();
    console.log(`🚚 Pedido #${pedidoId} foi entregue`);
    
    // Emite para todos os clientes
    io.emit('pedido.entregue', pedido);
  });

  // EVENTO 7: sistema.reset (NOVO)
  // Origem: Cliente (Admin)
  // Descrição: Reseta o sistema (limpa todos os pedidos)
  socket.on('sistema.reset', () => {
    console.log('🔄 Sistema resetado pelo admin');
    
    // Limpa todos os timers
    timersExpiracao.forEach((timer) => clearTimeout(timer));
    timersExpiracao.clear();
    
    // Reseta o estado
    pedidos = [];
    proximoId = 1;
    
    // Emite para todos
    io.emit('sistema.resetado', {
      mensagem: 'Sistema resetado com sucesso!',
      timestamp: new Date().toLocaleTimeString()
    });
  });

  // Cliente desconecta
  socket.on('disconnect', () => {
    console.log('🔌 Cliente desconectado:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📱 Acesse: http://localhost:${PORT}`);
});