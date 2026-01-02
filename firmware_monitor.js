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
const CSV_FILENAME = 'equipamentos_uniFLOW_online.csv';
const BUCKET_NAME = 'firmwares-canon.firebasestorage.app'; // Bucket padrão
const SERVICE_ACCOUNT_KEY = 'serviceAccountKey.json';

// Configuração de E-mail (Gmail)
// Crie uma 'Senha de App' em: https://myaccount.google.com/apppasswords
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
    console.log('=== Iniciando Verificação de Firmware (Modo Nuvem) ===');
    console.log(`Data/Hora: ${new Date().toLocaleString('pt-BR')}`);

    // Debugar Variáveis de Ambiente (Segurança: Mostrar apenas parcialmente)
    if (process.env.EMAIL_USER) console.log(`Configurado Email User: ${process.env.EMAIL_USER}`);
    else console.warn('AVISO: EMAIL_USER não está definido no ambiente!');

    if (process.env.EMAIL_PASS) console.log('Configurado Email Pass: OK (Oculto)');
    else console.warn('AVISO: EMAIL_PASS não está definido no ambiente!');

    // 1. Inicializar Firebase
    if (!initializeFirebase()) {
        console.error('Falha crítica na inicialização do Firebase.');
        process.exit(1);
    }

    // 2. Carregar Referência (Storage do Firebase)
    console.log(`Baixando '${CSV_FILENAME}' do Firebase Storage...`);
    let referenceMap;
    try {
        referenceMap = await loadReferenceFromStorage();
        console.log(`Carregados ${Object.keys(referenceMap).length} equipamentos do CSV de referência.`);

        if (Object.keys(referenceMap).length === 0) {
            console.error('ERRO CRÍTICO: O CSV parece estar vazio ou com problemas na leitura (zero registros encontrados).');
            process.exit(1);
        }

    } catch (error) {
        console.error('ERRO CRÍTICO: Não foi possível ler o CSV do Storage.');
        console.error('Verifique se você fez upload do arquivo para o Firebase Storage.');
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

        // DEBUG AMPLIADO
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
        console.error('Por favor, certifique-se que o Secret FIREBASE_SERVICE_ACCOUNT_BASE64 foi configurado corretamente no GitHub.');
        return false;
    }

    try {
        if (!admin.apps.length) {
            const serviceAccount = require(path.join(__dirname, SERVICE_ACCOUNT_KEY));
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                storageBucket: BUCKET_NAME
            });
        }
        return true;
    } catch (error) {
        console.error('Erro ao inicializar Firebase:', error);
        return false;
    }
}

function loadReferenceFromStorage() {
    return new Promise(async (resolve, reject) => {
        const bucket = admin.storage().bucket();
        const file = bucket.file(CSV_FILENAME);

        try {
            const [exists] = await file.exists();
            if (!exists) {
                console.error(`O arquivo ${CSV_FILENAME} não existe no bucket ${BUCKET_NAME}`);
                reject(new Error("Arquivo não encontrado no Storage"));
                return;
            }

            const [buffer] = await file.download();
            const referenceMap = {};
            const stream = Readable.from(buffer.toString());

            stream
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

        } catch (error) {
            reject(error);
        }
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

    // Remove caracteres não numéricos exceto ponto
    const cleanV1 = v1.replace(/[^0-9.]/g, '').split('.');
    const cleanV2 = v2.replace(/[^0-9.]/g, '').split('.');

    const len = Math.max(cleanV1.length, cleanV2.length);

    for (let i = 0; i < len; i++) {
        const num1 = parseInt(cleanV1[i] || 0);
        const num2 = parseInt(cleanV2[i] || 0);

        if (num1 < num2) return true;
        if (num1 > num2) return false;
    }

    return false; // São iguais
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
        <p>Os seguintes equipamentos estão com firmware desatualizado em relação à base de referência (CSV na Nuvem):</p>
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
    // Cron syntax: Minute Hour DayOfMonth Month DayOfWeek
    console.log('Verificação programada para Sextas às 09:00.');
    cron.schedule('0 9 * * 5', () => {
        main();
    });
}
