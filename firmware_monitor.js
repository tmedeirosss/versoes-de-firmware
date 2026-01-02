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

    // 1. Inicializar Firebase
    if (!initializeFirebase()) return;

    // 2. Carregar Referência (Storage do Firebase)
    console.log(`Baixando '${CSV_FILENAME}' do Firebase Storage...`);
    let referenceMap;
    try {
        referenceMap = await loadReferenceFromStorage();
        console.log(`Carregados ${Object.keys(referenceMap).length} equipamentos do CSV de referência.`);

        if (Object.keys(referenceMap).length === 0) {
            console.warn('AVISO: O CSV parece estar vazio ou com problemas na leitura (zero registros encontrados).');
        }

    } catch (error) {
        console.error('ERRO CRÍTICO: Não foi possível ler o CSV do Storage.');
        console.error('Verifique se você fez upload do arquivo para o Firebase Storage.');
        console.error('Erro detalhado:', error.message);
        return;
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
    }

    console.log('=== Fim da Verificação ===');
}

function initializeFirebase() {
    if (!fs.existsSync(SERVICE_ACCOUNT_KEY)) {
        console.error(`ERRO: Arquivo '${SERVICE_ACCOUNT_KEY}' não encontrado.`);
        console.error('Por favor, baixe a chave privada em: Configurações do Projeto > Contas de serviço > Gerar nova chave privada');
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
                // Tenta verificar se o erro é permissão ou arquivo inexistente
                console.error(`O arquivo ${CSV_FILENAME} não existe no bucket ${BUCKET_NAME}`);
                reject(new Error("Arquivo não encontrado no Storage"));
                return;
            }

            // Baixa o arquivo para a memória
            const [buffer] = await file.download();
            const referenceMap = {};

            // Converte buffer para stream legível para o csv-parser
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

// Comparador simples de versões (ex: 1.0.1 vs 1.0.2)
function isVersionLower(v1, v2) {
    if (!v1 || !v2) return false;

    // Remove caracteres não numéricos exceto ponto e traço
    // Divide por pontos
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
        console.log('Credenciais de e-mail não configuradas no arquivo .env. Pulando envio.');
        return;
    }

    const transporter = nodemailer.createTransport(EMAIL_CONFIG);

    // Montar HTML do e-mail
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
        console.log('E-mail enviado: %s', info.messageId);
    } catch (error) {
        console.error('Erro ao enviar e-mail:', error);
    }
}

// ==========================================
// SCHEDULING (Agendamento)
// ==========================================

// Se passar argumento --now, roda imediatamente
if (process.argv.includes('--now')) {
    main();
} else {
    // Cron syntax: Minute Hour DayOfMonth Month DayOfWeek
    // 0 9 * * 5 = Sextas às 09:00
    console.log('Verificação programada para Sextas às 09:00.');
    cron.schedule('0 9 * * 5', () => {
        main();
    });
}
