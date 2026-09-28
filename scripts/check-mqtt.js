import mqtt from 'mqtt';
import WebSocket from 'ws';
const seen = new Set();
const sent = new Set();
const client = mqtt.connect(process.env.MQTT_URL, { reconnectPeriod: 0, connectTimeout: 15000,
  createWebsocket: url => {
    const ws = new WebSocket(url, ['mqtt'], { headers: { 'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET }, handshakeTimeout: 15000 });
    ws.on('upgrade', response => console.log(JSON.stringify({ handshakeStatus: response.statusCode, protocol: response.headers['sec-websocket-protocol'] })));
    return ws;
  }
});
const timer = setTimeout(() => { console.log(JSON.stringify({ receivedFields: [...seen].sort(), outgoingPacketTypes: [...sent].sort(), publishedTopics: sent.has('publish') })); client.end(true); }, 20000);
client.on('packetsend', packet => { sent.add(packet.cmd); if (packet.cmd === 'connect' && packet.will) throw new Error('Read-only connection must not set a will'); });
client.on('connect', () => { console.log('MQTT connected'); client.subscribe('teslamate/cars/+/+', (error, granted) => console.log(JSON.stringify({ subscriptionAccepted: !error && granted?.every(g => g.qos !== 128) }))); });
client.on('message', (topic, payload) => { const field = topic.split('/').at(-1); seen.add(field); if (['location', 'active_route'].includes(field)) { try { const value = JSON.parse(payload.toString()); console.log(JSON.stringify({ field, keys: Object.keys(value), hasLocation: !!value.location, hasRouteError: !!value.error })); } catch { console.log(JSON.stringify({ field, validJson: false })); } } });
client.on('error', error => { console.log(JSON.stringify({ error: error.message.replace(/https?:\/\/\S+/g, '[endpoint]') })); clearTimeout(timer); client.end(true); process.exitCode = 1; });
