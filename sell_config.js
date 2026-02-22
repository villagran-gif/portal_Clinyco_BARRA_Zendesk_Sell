module.exports = {
  contact: {
    // CANÓNICO (anti-duplicados)
    RUT_NORM_ID: 6265931, // RUT_normalizado ✅

    // LEGACY (solo espejo/compat)
    RUT_ID: 5883525, // "RUT o ID"

    // Espejos requeridos (Medinet)
    PREVISION_ID: 6373567, // "Previsión" (list) ✅ espejo
    BIRTHDATE_ID: 5863844, // "Fecha Nacimiento" (date)

    // Otros
    TELEFONO_ID: 5862996,
    CORREO_ID: 5862966,
    CIUDAD_ID: 5862997,
    AGENTE_ID: 6336406
  },

  deal: {
    // CANÓNICO (anti-duplicados dentro del pipeline)
    RUT_NORM_ID: 2759433, // RUT_normalizado ✅

    // LEGACY
    RUT_ID: 2540090, // "RUT o ID"

    // Canónicos proceso
    BIRTHDATE_ID: 2618055, // "Fecha Nacimiento" (date)
    PREVISION_ID: 2761582, // "Previsión" (list) ✅ canónico en deal
    TRAMO_ID: 2758483,     // "Tramo/Modalidad" (list)

    // Existentes en el proyecto
    CIRUJANO_ID: 2523888,
    IMC_TEXT_ID: 1291633,
    IMC_NUM_ID: 2567322,
    INTERES_ID: 1291635,
    URL_MEDINET_ID: 2618053
  },

  bariatrica: {
    PIPELINE_ID: 1290779,
    STAGE_CANDIDATO_ID: 10693252
  }
};
