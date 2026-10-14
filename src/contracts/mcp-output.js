const outputSchema = {
  type: 'object',
  oneOf: [
    { type: 'object', required: ['ok','contract_version','request_id','data','meta'], additionalProperties: false,
      properties: { ok: { const: true }, contract_version: { const: '1' }, request_id: { type: 'string' },
        data: { type: 'object' }, meta: { type: 'object', required: ['generated_at','business_date','timezone','effective_filters','consistency','pagination','warnings','calculation_version'],
          properties: { generated_at: { type: 'string' }, business_date: { type: 'string' }, timezone: { const: 'Asia/Shanghai' },
            effective_filters: { type: 'object' }, consistency: { type: 'string' }, pagination: { type: ['object','null'] },
            warnings: { type: 'array' }, calculation_version: { type: ['string','null'] } } } } },
    { type: 'object', required: ['ok','error','request_id'], additionalProperties: false,
      properties: { ok: { const: false }, request_id: { type: 'string' },
        error: { type: 'object', required: ['code','message','retryable','details'], additionalProperties: false,
          properties: { code: { type: 'string' }, message: { type: 'string' }, retryable: { type: 'boolean' }, details: { type: 'object' } } } } },
  ],
};
module.exports = { outputSchema };
