/*  Copyright (C) 2019 Milan Pässler
    Copyright (C) 2019 HopGlass Server contributors

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published
    by the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>. */

'use strict'

const _ = require('lodash')
const https = require('https')
const http = require('http')
const fetch = require('./node-fetch.js').default
const TWO_HOURS_AGO = Date.now() - 1000 * 60 * 60 * 2

const httpAgent = new http.Agent({
  insecureHTTPParser: true,
})
const httpsAgent = new https.Agent({
  insecureHTTPParser: true,
  rejectUnauthorized: false,
  minVersion: 'TLSv1',
  ciphers: 'ALL',
})

const fetchOptions = {
  agent: x509Agent,
  insecureHTTPParser: true
}

const config = {
  /* eslint-disable quotes */
  "fetchloc": "https://ffgraz-ygg.mkg20001.io/ol/all.json",
  "topoloc": "http://127.0.0.1:9090",
  "interval": 1000 * 60,
  "queryInterval": 1000 * 60 + 2,
}

delete require.cache[__filename]

function x509Agent(_parsedURL) {
  if (_parsedURL.protocol == 'http:') {
    return httpAgent
  } else {
    return httpsAgent
  }
}

function netmaskToCIDR(netmask) {
  return (netmask.split('.').map(i => parseInt(i, 10).toString(2)).join('') + '0').indexOf(0)
}

function getType(name, ip, netmask) {
  function nct(str) {
    return name.indexOf(str) !== -1
  }

  if (nct('lan') || nct('wan') || nct('other') || nct('eth')) {
    return 'wired'
  }

  if (nct('wifi') || nct('radio')) {
    return 'wireless'
  }

  if (nct('tunnel') || nct('public') || ip.startsWith('10.12.11.')) {
    return 'tunnel'
  }

  // return 'other'
}

function * locationToNodes (locationId, location, conns) {
  for (const node of location.nodes) {
    const valid = node.type !== 'gluon' && conns[`manman.${node.id}`] && location.location.name !== 'unknown'
    if (valid && !node.respondd) {
      yield {
        nodeinfo: {
          node_id: `manman.${node.id}`,
          location: {
            latitude: location.location.lat,
            longitude: location.location.long
          },
          owner: {
            name: location.administrator.nick,
            contact: `${location.administrator.nick} /manman` // location.administrator.email
          },
          hostname: `${location.location.name}-${node.name}`,
          network: {
            addresses: node.interfaces.map(({ ip, netmask }) => `${ip}/${netmaskToCIDR(netmask)}`),
            interfaces: node.interfaces.map(({ name, ip, netmask, online, type }) => [name, { ip: `${ip}/${netmaskToCIDR(netmask)}`, up: online, type } ]).reduce((a, b) => { a[b[0]] = b[1]; return a }, {}),
            mac: `manman.${node.id}`,
            mesh: node.interfaces.map(({ id, name, ip, netmask }) => {
              const type = getType(name, ip, netmask)
              return type ? {
                [`manman.${node.id}.${id}`]: {
                  interfaces: {
                    [type]: [`manman.${node.id}.${id}`]
                  }
                }
              } : {}
            }).reduce((a, b) => Object.assign(a, b), {})
          },
          software: {
            firmware: {
              base: node.type && node.type.fw || node.type,
              release: node.type && node.type.version || node.type
            }
          },
          manman: {
            enabled: true,
            location: location.location.name,
            location_id: locationId,
            node: node.name,
            node_id: node.id
          }
        }
      }
    } else if (valid && node.respondd) {
      yield {
        overlay: true,
        nodeinfo: {
          node_id: node.respondd.node_id,
          location: {
            latitude: location.location.lat,
            longitude: location.location.long
          },
          owner: {
            name: location.administrator.nick,
            contact: `${location.administrator.nick} /manman` // location.administrator.email
          },
          software: node.respondd.firmware ? {
            firmware: {
              base: node.type && node.type.fw || node.type,
              release: node.type && node.type.version || node.type
            }
          } : {},
          manman: {
            enabled: true,
            location: location.location.name,
            location_id: locationId,
            node: node.name,
            node_id: node.id
          }
        }
      }
    }

    if (valid && (!node.respondd || node.respondd.neighbours)) {
      yield {
        overlay: Boolean(node.respondd),
        neighbours: {
          node_id: node.respondd ? node.respondd.node_id : `manman.${node.id}`,
          batadv: {
            [`manman.${node.id}`]: { // we can't get the interface they are connected to on our side,
              // so we just do this wild guessing and hope it works
              neighbours: (conns[`manman.${node.id}`] || []).map(conn => {
                const {intf} = conn.otherSide || { intf: {} }

                return {
                  [conn.node]: {
                    tq: conn.tq,
                    etx: conn.etx,
                    ip: conn.nodeIp,
                    ifname: intf.name, // this is the OTHER side's interface
                  }
                }
              }).reduce((a, b) => Object.assign(a, b), {})
            }
          }
        }
      }
    }
  }
}

function handleRequest(cb) {
  return res => {
    res.setEncoding('utf8')

    let data = ''

    res.on('data', dataNew => {
      data += dataNew
    })
    res.on('end', () => {
      try {
        data = JSON.parse(data)
      } catch (error) {
        return console.error(error)
      }

      cb(data)
    })
    res.on('error', err => {
      console.error(err)
    })
  }
}

const types = ['nodeinfo', 'neighbours', 'statistics']

async function tryQuery(url) {
  const req = await fetch(url, fetchOptions)
  return await req.json()
}

function getHandler(url, cb) {
  const parsed = new URL(url)
  if (parsed.protocol === 'https:') return https.get(url, cb)
  if (parsed.protocol === 'http:') return http.get(url, cb)
  throw new Error('Unknown proto ' + parsed.protocol)
}

module.exports = function(receiverId, configData, api) {
  _.merge(config, configData)

  let gQueryRespondd = {}

  function fetch() {
    getHandler(config.fetchloc, handleRequest(data => {
      getHandler(config.topoloc, handleRequest(topo => {
        const ipToManMan = {}
        const ipToManManSpecific = {}
        const isGluon = {}
        const ipToObject = {}

        const ipToRespondd = {}
        const queryRespondd = {}

        const _raw = api._unsafeGetRaw()

        for (const node in _raw) {
          if (!node.startsWith('manman')) {
            const addrs = _raw[node]?.nodeinfo?.network?.addresses
            if (addrs && addrs.length) {
              for (const addr of addrs) {
                ipToRespondd[addr] = {
                  mac: _raw[node]?.nodeinfo?.network?.mac,
                  neighbours: !Object.keys(_raw[node]?.neighbours?.batadv || {}).length,
                  firmware: !Object.keys(_raw[node]?.nodeinfo?.software?.firmware || {}).length,
                  node_id: _raw[node]?.nodeinfo?.node_id
                }
              }
            }
          }
        }

        for (const location of Object.values(data)) {
          if (location.location.name.startsWith('unknown')) {
            continue
          }

          for (const node of location.nodes) {
            for (const intf of node.interfaces) {
              ipToManMan[intf.ip] = `manman.${node.id}`
              ipToManManSpecific[intf.ip] = node.id ? `manman.${node.id}.${intf.id}` : ipToManMan[intf.ip]
              isGluon[intf.ip] = node.type === 'gluon' && node.mac

              if (node.type === 'gluon' && _raw[`manman.${node.id}`]) {
                // old non-gluon entry
                console.log('delete non-gluon switch artifact %s %s %o', location.location.name, node.name, node.id)
                delete _raw[`manman.${node.id}`]
              }

              if (intf.responddPath) {
                for (const type of types) {
                  const id = node.id + '-' + type
                  if (!queryRespondd[id]) queryRespondd[id] = []
                  queryRespondd[id].push(['http://' + intf.ip + intf.responddPath.replace('QUERY', type), type])
                }
              }

              if (ipToRespondd[intf.ip] && node.type !== 'gluon') {
                node.respondd = ipToRespondd[intf.ip]
                if (_raw[`manman.${node.id}`]) {
                  console.log('delete non-respondd artifact %s %s %o', location.location.name, node.name, node.id)
                  _raw[node.respondd.node_id].firstseen = _raw[`manman.${node.id}`].firstseen
                  delete _raw[`manman.${node.id}`]
                }
              }

              ipToObject[intf.ip] = {
                intf,
                node,
                location,
              }
            }
          }
        }

        const nodes = {}

        function addEntry(node, src, dest) {
          const m = ipToManMan[src] || src

          if (!nodes[m]) nodes[m] = []
          nodes[m].push({
            ip: src,
            node: isGluon[dest] || (ipToRespondd[dest] && ipToRespondd[dest].node_id) || ipToManManSpecific[dest] || dest,
            nodeIp: dest,
            otherSide: ipToObject[dest],
            // fake tq from etx
            tq: 255 * (node.linkQuality * node.neighborLinkQuality),
            etx: 1 / (node.linkQuality * node.neighborLinkQuality),
          })
        }

        gQueryRespondd = queryRespondd

        for (const node of topo.topology) {
          addEntry(node, node.lastHopIP, node.destinationIP)
          addEntry(node, node.destinationIP, node.lastHopIP)
        }

        for (const [locationId, location] of Object.entries(data)) {
          for (const node of locationToNodes(locationId, location, nodes)) {
            api.receiverCallback(node.nodeinfo ? node.nodeinfo.node_id : node.neighbours.node_id, node, node.overlay ? 1 : receiverId)
          }
        }
      })).on('error', console.error)
    })).on('error', console.error)
  }

  function doQueryRespondd() {
    for (const list of Object.values(gQueryRespondd)) {
      (async function () {
        for (const [url, type] of list) {
          try {
            const res = await tryQuery(url)
            if (res) api.receiverCallback(res.node_id, { [type]: res }, receiverId)
          } catch(error) {
            // do nothing
          }
        }
      })()
    }
  }

  setInterval(fetch, config.interval).unref()
  setInterval(doQueryRespondd, config.queryInterval).unref()

  fetch()
}
