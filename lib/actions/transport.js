/* Copyright (c) 2015 - 2018, Nordic Semiconductor ASA
 *
 * All rights reserved.
 *
 * Use in source and binary forms, redistribution in binary form only, with
 * or without modification, are permitted provided that the following conditions
 * are met:
 *
 * 1. Redistributions in binary form, except as embedded into a Nordic
 *    Semiconductor ASA integrated circuit in a product or a software update for
 *    such product, must reproduce the above copyright notice, this list of
 *    conditions and the following disclaimer in the documentation and/or other
 *    materials provided with the distribution.
 *
 * 2. Neither the name of Nordic Semiconductor ASA nor the names of its
 *    contributors may be used to endorse or promote products derived from this
 *    software without specific prior written permission.
 *
 * 3. This software, with or without modification, must only be used with a Nordic
 *    Semiconductor ASA integrated circuit.
 *
 * 4. Any software provided in binary form under this license must not be reverse
 *    engineered, decompiled, modified and/or disassembled.
 *
 * THIS SOFTWARE IS PROVIDED BY NORDIC SEMICONDUCTOR ASA "AS IS" AND ANY EXPRESS OR
 * IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
 * MERCHANTABILITY, NONINFRINGEMENT, AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL NORDIC SEMICONDUCTOR ASA OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
 * TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
 * THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

// For electron runtime optimization we need to avoid operator-assiment:
/* eslint operator-assignment: off */

import EventEmitter from 'events';

import Device from './device';

import {
    ADC_SAMPLING_TIME_US,
    AVERAGE_TIME_US,

    STX, ETX, ESC,
    ADC_MULT,

    MEAS_RANGE_NONE,
    MEAS_RANGE_LO,
    MEAS_RANGE_MID,
    MEAS_RANGE_HI,
    MEAS_RANGE_INVALID,

    MEAS_RANGE_POS,
    MEAS_RANGE_MSK,
    MEAS_ADC_MSK,
} from '../constants';

let MEAS_RES_HI = 1.8;
let MEAS_RES_MID = 28.0;
let MEAS_RES_LO = 510.0;
let device = null;

/**
    Metadata expected from the PPK firmware is a multiline string
    in the following format, where the parts in brackets are optional:

VERSION {version} CAL: {calibrationStatus} [R1: {resLo} R2: {resMid} R3: {resHi}] Board ID {boardID}
[USER SET R1: {userResLo} R2: {userResMid} R3: {userResHi}]
Refs VDD: {vdd} HI: {vrefHigh} LO: {vrefLow}

 */
const MetadataParser = new RegExp([
    'VERSION\\s*([^\\s]+)\\s*CAL:\\s*(\\d+)\\s*',
    '(?:R1:\\s*([\\d.]+)\\s*R2:\\s*([\\d.]+)\\s*R3:\\s*([\\d.]+))?\\s*Board ID\\s*([0-9A-F]+)\\s*',
    '(?:USER SET\\s*R1:\\s*([\\d.]+)\\s*R2:\\s*([\\d.]+)\\s*R3:\\s*([\\d.]+))?\\s*',
    'Refs\\s*VDD:\\s*(\\d+)\\s*HI:\\s*(\\d.+)\\s*LO:\\s*(\\d+)',
].join(''));

export const events = new EventEmitter();

let byteHandlerFunc;
let timestamp = 0;
// Array to hold the valid bytes of the payload
let dataPayload = [];

function getAdcResult(adcVal, range) {
    switch (range) {
        case MEAS_RANGE_LO:
            return adcVal * (ADC_MULT / MEAS_RES_LO);
        case MEAS_RANGE_MID:
            return adcVal * (ADC_MULT / MEAS_RES_MID);
        case MEAS_RANGE_HI:
            return adcVal * (ADC_MULT / MEAS_RES_HI);
        case MEAS_RANGE_NONE:
            throw new Error('Measurement range not detected');
        case MEAS_RANGE_INVALID:
        default:
    }
    throw new Error('Invalid range');
}


// Allocate memory for the float value
const averageBuf = new ArrayBuffer(4);
// Typed array used for viewing the final 4-byte array as uint8_t values
const serialUint8View = new Uint8Array(averageBuf);
// View for the final float value that is pushed to the chart
const viewFloat = new Float32Array(averageBuf);

function handleAverageDataSet(data, ts) {
    try {
        serialUint8View.set(data);
    } catch (e) {
        events.emit('error', 'Average data error, restart application', e);
    }
    try {
        const averageFloatValue = viewFloat[0];
        // Only fire the event, if the buffer data is valid
        events.emit('average', averageFloatValue, ts);
    } catch (e) {
        events.emit('error', 'Average data error, restart application', e);
    }
}

let triggerBuf = new ArrayBuffer(0);
let resultBuffer = new Array(0);
let viewUint8 = new Uint8Array(triggerBuf);

function handleTriggerDataSet(data, ts) {
    if (triggerBuf.length !== data.length) {
        triggerBuf = new ArrayBuffer(data.length);
        resultBuffer = new Array(Math.trunc(data.length / 2));
        viewUint8 = new Uint8Array(triggerBuf);
    }

    viewUint8.set(data);
    const view = new DataView(triggerBuf);
    for (let i = 0; i < resultBuffer.length; i = i + 1) {
        const adcValue = view.getUint16(i + i, true);

        // eslint-disable-next-line no-bitwise
        const currentMeasurementRange = (adcValue & MEAS_RANGE_MSK) >> MEAS_RANGE_POS;

        // eslint-disable-next-line no-bitwise
        const adcResult = (adcValue & MEAS_ADC_MSK);
        resultBuffer[i] = getAdcResult(adcResult, currentMeasurementRange) * 1e6;
    }
    const timeOfLastValue = ts + (ADC_SAMPLING_TIME_US * resultBuffer.length);
    events.emit('trigger', resultBuffer.slice(), timeOfLastValue);
}

const sysTickBuf = new ArrayBuffer(4);
const sysTickViewUint8 = new Uint8Array(sysTickBuf);
const sysTickView = new DataView(sysTickBuf);

function convertSysTick2MicroSeconds(data) {
    sysTickViewUint8.set(data);
    const sysTicks = sysTickView.getUint32(data, true);
    return sysTicks * ADC_SAMPLING_TIME_US;
}

const byteHandlers = {
    MODE_RECEIVE: byte => {
        /*  ESC received means that a valid data byte was either
         * ETX or ESC. Two bytes are sent, ESC and then valid ^ 0x20
         */
        switch (byte) {
            case ESC:
                // Don't do anything here, but wait for next byte and XOR it
                byteHandlerFunc = byteHandlers.MODE_ESC_RECV;
                // End of transmission, send to average or trigger handling
                return;
            case ETX: {
                if (dataPayload.length === 4) {
                    handleAverageDataSet(dataPayload, timestamp);
                    timestamp = timestamp + AVERAGE_TIME_US;
                } else if (dataPayload.length === 5) {
                    timestamp = convertSysTick2MicroSeconds(dataPayload.slice(0, 4));
                } else {
                    try {
                        handleTriggerDataSet(dataPayload, timestamp);
                    } catch (error) {
                        events.emit(
                            'error',
                            'Corrupt data detected, please check connection to PPK.',
                            error,
                        );
                    }
                }
                dataPayload = [];
                byteHandlerFunc = byteHandlers.MODE_RECEIVE;

                return;
            }
            default:
                // Input the value at the end of result array
                dataPayload.push(byte);
        }
    },
    MODE_ESC_RECV: byte => {
        // XOR the byte after the ESC-character
        // Remove these two bytes, the ESC and the valid one

        /* eslint-disable no-bitwise */
        const modbyte = (byte ^ 0x20);
        dataPayload.push(modbyte);
        byteHandlerFunc = byteHandlers.MODE_RECEIVE;
    },
};

byteHandlerFunc = byteHandlers.MODE_RECEIVE;

function parseMeasurementData(rawbytes) {
    rawbytes.forEach(byte => byteHandlerFunc(byte));
}

export function setResistors(low, mid, high) {
    MEAS_RES_HI = high;
    MEAS_RES_MID = mid;
    MEAS_RES_LO = low;
}

export function PPKCommandSend(cmd) {
    const slipPackage = [];
    if (cmd.constructor !== Array) {
        events.emit('error', 'Unable to issue command', 'Command is not an array');
        return undefined;
    }

    slipPackage.push(STX);

    cmd.forEach(byte => {
        if (byte === STX || byte === ETX || byte === ESC) {
            slipPackage.push(ESC, byte ^ 0x20);
        } else {
            slipPackage.push(byte);
        }
    });
    slipPackage.push(ETX);

    return device.write(slipPackage);
}

export async function stop() {
    if (!device) {
        return;
    }
    await device.stop();
    device = null;
}

/* Called when selecting device */
export async function start(descr) {
    device = new Device(descr, events, parseMeasurementData);
    const hardwareStates = await device.start();

    const match = MetadataParser.exec(hardwareStates);
    if (!match) {
        events.emit('error', 'Failed to read PPK metadata');
        return undefined;
    }

    const [, version, calibrationStatus,,,, boardID] = match;
    let [,,,
        resLo, resMid, resHi,,
        userResLo, userResMid, userResHi,
        vdd, vrefHigh, vrefLow,
    ] = match;

    if (vdd) vdd = parseInt(vdd, 10);
    if (vrefHigh) vrefHigh = parseInt(vrefHigh, 10);
    if (vrefLow) vrefLow = parseInt(vrefLow, 10);
    if (resLo) resLo = parseFloat(resLo);
    if (resMid) resMid = parseFloat(resMid);
    if (resHi) resHi = parseFloat(resHi);
    if (userResLo) userResLo = parseFloat(userResLo);
    if (userResMid) userResMid = parseFloat(userResMid);
    if (userResHi) userResHi = parseFloat(userResHi);

    return {
        version,
        calibrationStatus,
        resLo,
        resMid,
        resHi,
        userResLo,
        userResMid,
        userResHi,
        boardID,
        vdd,
        vrefHigh,
        vrefLow,
    };
}
