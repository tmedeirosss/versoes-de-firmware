const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const { Readable } = require('stream');
require('dotenv').config();

// ==========================================
// CONFIGURAÇÃO
// ==========================================
// Como estamos rodando no GitHub Actions com 'actions/checkout',
// o arquivo estará na mesma pasta raiz do projeto.
const CSV_FILE = 'equipamentos_uniFLOW_online.csv';
const SERVICE_ACCOUNT_KEY = 'serviceAccountKey.json';

// Configuração de E-mail (Gmail)
const EMAIL_CONFIG = {
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
};

const EMAIL_DEST = process.env.EMAIL_DEST || process.env.EMAIL_USER;

// ==========================================
// LÓGICA
// ==========================================

async function main() {
    console.log('=== Iniciando Verificação de Firmware (Modo GitHub Actions / Local) ===');
    console.log(`Data/Hora: ${new Date().toLocaleString('pt-BR')}`);

    // Debugar Variáveis de Ambiente
    if (process.env.EMAIL_USER) console.log(`Configurado Email User: ${process.env.EMAIL_USER}`);
    else console.warn('AVISO: EMAIL_USER não está definido no ambiente!');

    // 1. Inicializar Firebase
    if (!initializeFirebase()) {
        console.error('Falha crítica na inicialização do Firebase.');
        process.exit(1);
    }

    // 2. Carregar Referência (Arquivo Local do Repositório)
    console.log(`Lendo arquivo local: '${CSV_FILE}'...`);
    let referenceMap;
    try {
        referenceMap = await loadReferenceCSV();
        console.log(`Carregados ${Object.keys(referenceMap).length} equipamentos do CSV de referência.`);

        if (Object.keys(referenceMap).length === 0) {
            console.error('ERRO CRÍTICO: O CSV parece estar vazio (zero registros).');
            process.exit(1);
        }

    } catch (error) {
        console.error(`ERRO CRÍTICO: Não foi possível ler o arquivo local '${CSV_FILE}'.`);
        console.error('Certifique-se que este arquivo está na raiz do seu repositório GitHub e foi enviado (git push).');
        console.error('Erro detalhado:', error.message);
        process.exit(1);
    }

    // 3. Buscar Dados do Firebase
    const firebaseRecords = await getFirebaseRecords();
    console.log(`Encontrados ${firebaseRecords.length} registros no banco de dados.`);

    // 4. Comparar Versões
    const updatesNeeded = checkFirmwareStatus(firebaseRecords, referenceMap);

    // 5. Enviar Relatório
    if (updatesNeeded.length > 0) {
        console.log(`Identificados ${updatesNeeded.length} equipamentos desatualizados.`);
        await sendEmailReport(updatesNeeded);
    } else {
        console.log('Nenhum equipamento precisa de atualização no momento.');

        if (firebaseRecords.length > 0) {
            console.log('--- DIAGNÓSTICO DO PRIMEIRO REGISTRO ---');
            const sample = firebaseRecords[0];
            const refVersion = referenceMap[sample.serial];
            console.log(`Serial: ${sample.serial}`);
            console.log(`Versão Banco: ${sample.firmware}`);
            console.log(`Versão CSV:   ${refVersion || 'NÃO ENCONTRADA (Serial não bate com CSV)'}`);
            if (refVersion) {
                console.log(`Resultado Comparação: ${isVersionLower(sample.firmware, refVersion) ? 'DESATUALIZADO' : 'ATUALIZADO'}`);
            }
            console.log('----------------------------------------');
        } else {
            console.log('O banco de dados do Firebase está vazio.');
        }
    }

    console.log('=== Fim da Verificação ===');
}

function initializeFirebase() {
    if (!fs.existsSync(SERVICE_ACCOUNT_KEY)) {
        console.error(`ERRO: Arquivo '${SERVICE_ACCOUNT_KEY}' não encontrado.`);
        console.error('Nota: No GitHub Actions, ele é criado a partir do Secret FIREBASE_SERVICE_ACCOUNT_BASE64.');
        return false;
    }

    try {
        if (!admin.apps.length) {
            const serviceAccount = require(path.join(__dirname, SERVICE_ACCOUNT_KEY));
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
                // Nota: storageBucket removido pois não vamos usar mais
            });
        }
        return true;
    } catch (error) {
        console.error('Erro ao inicializar Firebase:', error);
        return false;
    }
}

function loadReferenceCSV() {
    return new Promise((resolve, reject) => {
        const referenceMap = {};

        if (!fs.existsSync(CSV_FILE)) {
            reject(new Error("Arquivo não encontrado no sistema de arquivos local."));
            return;
        }

        fs.createReadStream(CSV_FILE)
            .pipe(csv({ separator: ';' }))
            .on('data', (row) => {
                const serial = row['Serial']?.trim();
                const lfv = row['LFV']?.trim();
                if (serial && lfv) {
                    referenceMap[serial] = lfv;
                }
            })
            .on('end', () => resolve(referenceMap))
            .on('error', reject);
    });
}

async function getFirebaseRecords() {
    const db = admin.firestore();
    const snapshot = await db.collection('firmwares').get();

    const records = [];
    snapshot.forEach(doc => {
        records.push(doc.data());
    });

    return records;
}

function checkFirmwareStatus(records, referenceMap) {
    const updatesNeeded = [];

    records.forEach(record => {
        const serial = record.serial;
        const currentVersion = record.firmware;
        const latestVersion = referenceMap[serial];

        if (latestVersion) {
            if (isVersionLower(currentVersion, latestVersion)) {
                updatesNeeded.push({
                    serial: serial,
                    current: currentVersion,
                    latest: latestVersion,
                    lastCheck: record.date
                });
            }
        }
    });

    return updatesNeeded;
}

function isVersionLower(v1, v2) {
    if (!v1 || !v2) return false;
    const cleanV1 = v1.replace(/[^0-9.]/g, '').split('.');
    const cleanV2 = v2.replace(/[^0-9.]/g, '').split('.');
    const len = Math.max(cleanV1.length, cleanV2.length);
    for (let i = 0; i < len; i++) {
        const num1 = parseInt(cleanV1[i] || 0);
        const num2 = parseInt(cleanV2[i] || 0);
        if (num1 < num2) return true;
        if (num1 > num2) return false;
    }
    return false;
}

async function sendEmailReport(list) {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        console.error('ERRO: Credenciais de e-mail não configuradas no ambiente.');
        process.exit(1);
        return;
    }

    const transporter = nodemailer.createTransport(EMAIL_CONFIG);

    const rows = list.map(item => `
        <tr>
            <td style="padding: 8px; border: 1px solid #ddd;">${item.serial}</td>
            <td style="padding: 8px; border: 1px solid #ddd; color: #d9534f;">${item.current}</td>
            <td style="padding: 8px; border: 1px solid #ddd; color: #5cb85c;"><b>${item.latest}</b></td>
            <td style="padding: 8px; border: 1px solid #ddd;">${item.lastCheck}</td>
        </tr>
    `).join('');

    const html = `
        <h2>Relatório de Atualização de Firmware</h2>
        <p>Os seguintes equipamentos estão com firmware desatualizado em relação à base de referência (CSV):</p>
        <table style="border-collapse: collapse; width: 100%; max-width: 600px;">
            <thead>
                <tr style="background-color: #f2f2f2;">
                    <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Serial</th>
                    <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Versão Atual</th>
                    <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Versão Esperada</th>
                    <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Última Coleta</th>
                </tr>
            </thead>
            <tbody>
                ${rows}
            </tbody>
        </table>
        <p><i>Este é um e-mail automático gerado pelo Sistema de Monitoramento de Firmware Canon.</i></p>
    `;

    const mailOptions = {
        from: `"Canon Firmware Monitor" <${process.env.EMAIL_USER}>`,
        to: EMAIL_DEST,
        subject: `[ALERTA] ${list.length} Equipamentos Requerem Atualização de Firmware`,
        html: html
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log('SUCESSO: E-mail enviado. ID:', info.messageId);
    } catch (error) {
        console.error('ERRO CRÍTICO AO ENVIAR EMAIL:', error);
        process.exit(1);
    }
}

// ==========================================
// SCHEDULING (Agendamento)
// ==========================================

if (process.argv.includes('--now')) {
    main();
} else {
    console.log('Verificação programada para Sextas às 09:00.');
    cron.schedule('0 9 * * 5', () => {
        main();
    });
}
