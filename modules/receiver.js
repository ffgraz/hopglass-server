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

const fs = require('fs')
const _ = require('lodash')
const async = require('async')

const config = {
  /* eslint-disable quotes */
  receivers: [
    { module: "announced" },
    { module: "aliases",
      overlay: true
    }
  ],
  ifaces: [
    "bat0"
  ],
  storage: {
    interval: 300,
    file: "./raw.json"
  },
  purge: {
    maxAge: 14,      // in days
    interval: 86400  //  1 day
  }
}

module.exports = function (observer, configData) {
  if (configData.ifaces)
    delete config.ifaces

  if (configData.receivers)
    delete config.receivers

  _.merge(config, configData)

  const receiverList = []
  let raw = {}
  const overlay = {}

  try {
    raw = JSON.parse(fs.readFileSync(config.storage.file, 'utf8'))
  } catch(err) {
    console.log(err)
  }

  const api = {}
  api.receiverCallback  = receiverCallback
  api.sharedConfig = config
  api.getRaw = getRaw
  api._unsafeGetRaw = () => raw
  for (const i in config.receivers) {
    const r = config.receivers[i]
    try {
      receiverList.push(require(__dirname + '/receiver/' + r.module)(i, r.config, api))
    } catch(err) {
      console.error('Error while initializing receiver "' + r.module + '": ', err)
      console.error('Exiting...')
      process.exit(1)
    }
  }

  function receiverCallback(id, obj, receiverId) {
    const receiverConf = config.receivers[receiverId]

    if (!raw[id]) {
      raw[id] = {}
      raw[id].firstseen = new Date().toISOString()
    }

    if (receiverConf.overlay) {
      if (!overlay[id])
        overlay[id] = {}

      _.merge(overlay[id], obj)
      delete raw[id].lastupdate
      return
    }

    raw[id].lastseen = new Date().toISOString()

    if (!raw[id].lastupdate)
      raw[id].lastupdate = {}

    if (obj.nodeinfo) {
      raw[id].nodeinfo = obj.nodeinfo
      raw[id].lastupdate.nodeinfo = new Date().toISOString()
    }
    if (obj.statistics) {
      if (_.has(raw[id], 'statistics.wireless')
       && _.has(obj, 'statistics.wireless')
       && Array.isArray(raw[id].statistics.wireless)
       && Array.isArray(obj.statistics.wireless)) {

        obj.statistics.airtime = []
        for (const freq of obj.statistics.wireless) {
          if (Number.isInteger(freq.frequency) &&
              Number.isInteger(freq.active) &&
              Number.isInteger(freq.busy)) {
            const oldfreq = raw[id].statistics.wireless
              .filter(f => f.frequency === freq.frequency)[0]

            if (!oldfreq) continue

            const activeDelta = (freq.active - oldfreq.active)

            obj.statistics.airtime.push({
              frequency: freq.frequency,
              busy: (freq.busy - oldfreq.busy) / activeDelta,
              rx: (_.get(freq, 'rx', 0) - _.get(oldfreq, 'rx', 0)) / activeDelta,
              tx: (_.get(freq, 'tx', 0) - _.get(oldfreq, 'tx', 0)) / activeDelta,
            })
          }
        }
      }
      raw[id].statistics = obj.statistics
      raw[id].lastupdate.statistics = new Date().toISOString()
    }
    if (obj.neighbours) {
      raw[id].neighbours = obj.neighbours
      raw[id].lastupdate.neighbours = new Date().toISOString()
    }

    observer.dataReceived(raw[id])
  }

  function getRaw() {
    return _.merge({}, raw)
  }

  function getData(query) {
    let data = getRaw()
    _.merge(data, overlay)

    if (typeof query === 'object')
      data = filterData(data, query)

    return data
  }

  function filterData(data, query) {
    // filtern anhand der übergebenen Filterwerte
    switch (query.filter) {
    case 'site':
      return _.pickBy(data, function(o) {
        return _.includes(_.split(query.value, ','), _.get(o, 'nodeinfo.system.site_code', 'unknown'))
      })
    case 'firmware_release':
      return _.pickBy(data, function(o) {
        return _.includes(_.split(query.value, ','), _.get(o, 'nodeinfo.software.firmware.release', 'unknown'))
      })
    case 'firstseen':
      return _.pickBy(data, function(o) {
        const firstseen = (new Date(o.firstseen)).getTime()
        const now = (new Date()).getTime()
        const v = parseInt(query.value)*1000
        if (v >= 0) {
          return now - firstseen <= v ? true : false           // all nodes seen last n seconds
        } else {
          return now - firstseen > Math.abs(v) ? true : false  // all nodes not seen in last n seconds
        }
      })
    case 'lastseen':
      return _.pickBy(data, function(o) {
        const lastseen = (new Date(o.lastseen)).getTime()
        const now = (new Date()).getTime()
        const v = parseInt(query.value)*1000
        if (v >= 0) {
          return now - lastseen <= v ? true : false
        } else {
          return now - lastseen > Math.abs(v) ? true : false
        }
      })
    case 'uptime':
      return _.pickBy(data, function(o) {
        const uptime = parseInt(_.get(o, 'statistics.uptime', '-1'))
        const v = parseInt(query.value)
        if (v >= 0) {
          return uptime <= v ? true : false
        } else {
          return uptime > Math.abs(v) ? true : false
        }
      })
    case 'clients':
      return _.pickBy(data, function(o) {
        const clients = parseInt(_.get(o, 'statistics.clients.total', '-1'))
        const v = parseInt(query.value)
        if (v >= 0) {
          return clients >= v ? true : false
        } else {
          return clients < Math.abs(v) ? true : false
        }
      })
    case 'nodeid':
      return _.pickBy(data, function(o) {
        return _.includes(_.split(query.value, ','), _.get(o, 'nodeinfo.node_id', 'unknown'))
      })
    default:
      return data
    }
  }

  function purgeData() {
    const now = new Date().getTime()
    async.forEachOf(raw, function(n, k, finished) {
      const lastseen = (new Date(n.lastseen)).getTime()
      if (now - lastseen >= config.purge.maxAge*86400*1000 || typeof n.lastseen === 'undefined') {
        console.info('purge old node ' + k)
        delete raw[k]
      }
      finished()
    })
  }
  purgeData()
  setInterval(purgeData, config.purge.interval*1000)

  function storeData() {
    try {
      const fn = fs.openSync(config.storage.file + '.tmp', 'w')
      fs.writeSync(fn, JSON.stringify(getRaw()))
      fs.fsyncSync(fn) // take care that it was actually written to disk
      fs.closeSync(fn)
      fs.renameSync(config.storage.file + '.tmp', config.storage.file) // prevent overwriting with an unfinished backup (happens if disk is full)
    } catch(err) {
      console.error(err)
    }
  }
  setInterval(storeData, config.storage.interval*1000)

  process.on('SIGINT', function () {
    storeData()
    process.exit(2)
  })

  process.on('SIGTERM', function () { // systemd kills with SIGTERM
    storeData()
    process.exit(0)
  })

  const exports = {}
  exports.getData = getData
  exports.getRaw  = getRaw
  return exports
}
