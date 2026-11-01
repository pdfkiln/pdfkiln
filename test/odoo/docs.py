# Run by `odoo-bin shell`: the documents the proof prints, from the demo
# data, and the server address wkhtmltopdf fetches the report assets from.
# Writes {name: [report, ids]} to the file named by ODOO_PROOF_DOCS.
import json
import os

icp = env['ir.config_parameter']
for key in ('web.base.url', 'report.url'):
    icp.set_str(key, 'http://127.0.0.1:8069')
icp.set_str('web.base.url.freeze', 'True')

company = env.company
# The layout Odoo's layout wizard proposes first (Light).
company.external_report_layout_id = env['report.layout'].search([], order='sequence', limit=1).view_id
mine = [('company_id', '=', company.id)]

orders = env['sale.order'].search(mine + [('state', '=', 'sale')], order='id')
order = max(orders, key=lambda o: len(o.order_line))

invoices = env['account.move'].search(mine + [('move_type', '=', 'out_invoice'), ('state', '=', 'posted')], order='id')

# An invoice of 36 lines: several pages, each with its header and footer.
products = env['product.product'].search([('sale_ok', '=', True), ('company_id', 'in', [False, company.id]), ('list_price', '>', 0)], order='default_code, id')
lines = []
for i in range(36):
    p = products[i % len(products)]
    lines.append((0, 0, {'product_id': p.id, 'quantity': 1 + i % 5, 'price_unit': p.list_price}))
long_invoice = env['account.move'].create({
    'move_type': 'out_invoice',
    'partner_id': invoices[0].partner_id.id,
    'invoice_line_ids': lines,
})
long_invoice.action_post()

pickings = env['stock.picking'].search(mine + [('picking_type_code', '=', 'outgoing'), ('state', '=', 'assigned'), ('partner_id', '!=', False)], order='id')
picking = max(pickings, key=lambda p: len(p.move_ids))
for move in picking.move_ids:
    move.quantity = move.product_uom_qty
    move.picked = True
picking.with_context(skip_sms=True).button_validate()

purchases = env['purchase.order'].search(mine + [('state', '=', 'draft')], order='id')
purchase = max(purchases, key=lambda p: len(p.order_line))
purchase.button_confirm()

docs = {
    'sale-order': ['sale.report_saleorder', [order.id]],
    'invoice': ['account.report_invoice_with_payments', [invoices[0].id]],
    'invoice-36-lines': ['account.report_invoice_with_payments', [long_invoice.id]],
    'two-invoices': ['account.report_invoice_with_payments', invoices[1:3].ids],
    'delivery-slip': ['stock.report_deliveryslip', [picking.id]],
    'purchase-order': ['purchase.report_purchaseorder', [purchase.id]],
}
env.cr.commit()
with open(os.environ['ODOO_PROOF_DOCS'], 'w') as f:
    json.dump(docs, f, indent=2)
print(json.dumps({k: [v[0], v[1], company.external_report_layout_id.key] for k, v in docs.items()}))
