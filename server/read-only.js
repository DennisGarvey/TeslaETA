// Defense against accidental future application-level topic writes.
// A broker ACL is still the authority for MQTT account permissions.
export function enforceReadOnly(client) {
  if (client.options.will) throw new Error('Read-only MQTT must not configure a last will');
  client.publish = () => { throw new Error('MQTT publishing is disabled: this app is read-only'); };
  client.publishAsync = async () => { throw new Error('MQTT publishing is disabled: this app is read-only'); };
  return client;
}
