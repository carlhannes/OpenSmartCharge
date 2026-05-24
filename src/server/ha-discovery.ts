import type { MqttClient } from 'mqtt'

interface LoadpointDiscoveryOpts {
  name: string
  topicPrefix: string
}

export function publishHaDiscovery(mqtt: MqttClient, loadpoints: string[], topicPrefix: string): void {
  for (const name of loadpoints) {
    publishLoadpointDiscovery(mqtt, { name, topicPrefix })
  }
}

function publishLoadpointDiscovery(mqtt: MqttClient, { name, topicPrefix }: LoadpointDiscoveryOpts): void {
  const prefix = `${topicPrefix}/loadpoints/${name}`
  const haBase = `homeassistant`
  const deviceId = `osc_${name.replace(/\W/g, '_')}`
  const device = {
    identifiers: [deviceId],
    name: `OSC ${name}`,
    manufacturer: 'OpenSmartCharge',
  }

  // Mode selector
  mqtt.publish(
    `${haBase}/select/${deviceId}_mode/config`,
    JSON.stringify({
      name: 'Charge mode',
      unique_id: `${deviceId}_mode`,
      device,
      state_topic: `${prefix}/mode`,
      command_topic: `${prefix}/cmd/mode`,
      options: ['smart', 'fast', 'disabled'],
      icon: 'mdi:ev-station',
    }),
    { retain: true },
  )

  // Current sensor
  mqtt.publish(
    `${haBase}/sensor/${deviceId}_current/config`,
    JSON.stringify({
      name: 'Charge current',
      unique_id: `${deviceId}_current`,
      device,
      state_topic: `${prefix}/current_a`,
      unit_of_measurement: 'A',
      device_class: 'current',
      state_class: 'measurement',
    }),
    { retain: true },
  )

  // Energy sensor
  mqtt.publish(
    `${haBase}/sensor/${deviceId}_energy/config`,
    JSON.stringify({
      name: 'Session energy',
      unique_id: `${deviceId}_energy`,
      device,
      state_topic: `${prefix}/energy_kwh`,
      unit_of_measurement: 'kWh',
      device_class: 'energy',
      state_class: 'total_increasing',
    }),
    { retain: true },
  )

  // Charging binary sensor
  mqtt.publish(
    `${haBase}/binary_sensor/${deviceId}_charging/config`,
    JSON.stringify({
      name: 'Charging',
      unique_id: `${deviceId}_charging`,
      device,
      state_topic: `${prefix}/state`,
      value_template: "{{ 'ON' if value_json.charging else 'OFF' }}",
      device_class: 'battery_charging',
    }),
    { retain: true },
  )
}
