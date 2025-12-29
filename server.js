const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const csv = require('csv-parser');

const app = express();
const PORT = 3000;
const CSV_FILE = path.join(__dirname, 'registros_firmware.csv');

app.use(cors());
app.use(bodyParser.json());

// Ensure CSV exists with headers
if (!fs.existsSync(CSV_FILE)) {
    const csvWriter = createCsvWriter({
        path: CSV_FILE,
        header: [
            {id: 'serial', title: 'NUMERO_SERIE'},
            {id: 'firmware', title: 'VERSAO_FIRMWARE'},
            {id: 'date', title: 'DATA_REGISTRO'}
        ]
    });
    // Create empty file with headers
    csvWriter.writeRecords([]).then(() => console.log('CSV file created'));
}

app.post('/save', (req, res) => {
    const { serial, firmware, date } = req.body;
    const records = [];

    // Read existing records
    fs.createReadStream(CSV_FILE)
        .pipe(csv())
        .on('data', (data) => records.push(data))
        .on('end', () => {
            let found = false;
            
            // Map records to match our internal structure if needed, 
            // but csv-parser returns objects with keys based on headers.
            // Headers are: NUMERO_SERIE, VERSAO_FIRMWARE, DATA_REGISTRO
            
            const updatedRecords = records.map(record => {
                if (record.NUMERO_SERIE === serial) {
                    found = true;
                    return {
                        NUMERO_SERIE: serial,
                        VERSAO_FIRMWARE: firmware,
                        DATA_REGISTRO: date
                    };
                }
                return record;
            });

            if (!found) {
                updatedRecords.push({
                    NUMERO_SERIE: serial,
                    VERSAO_FIRMWARE: firmware,
                    DATA_REGISTRO: date
                });
            }

            // Write back to file
            const csvWriter = createCsvWriter({
                path: CSV_FILE,
                header: [
                    {id: 'NUMERO_SERIE', title: 'NUMERO_SERIE'},
                    {id: 'VERSAO_FIRMWARE', title: 'VERSAO_FIRMWARE'},
                    {id: 'DATA_REGISTRO', title: 'DATA_REGISTRO'}
                ]
            });

            csvWriter.writeRecords(updatedRecords)
                .then(() => {
                    console.log('CSV updated');
                    res.json({ success: true, message: 'Registro salvo/atualizado no CSV!' });
                })
                .catch(err => {
                    console.error(err);
                    res.status(500).json({ success: false, message: 'Erro ao escrever no CSV' });
                });
        });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
