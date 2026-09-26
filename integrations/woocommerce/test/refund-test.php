<?php
define('ABSPATH', __DIR__);
class WP_Error {
    public function __construct(private $code, private $message) {}
    public function get_error_code() { return $this->code; }
    public function get_error_message() { return $this->message; }
}
function is_wp_error($x) { return $x instanceof WP_Error; }
function lmc_setting($key) { return $key === 'currency_unit' ? 'toman' : ''; }
function current_user_can($cap) { return true; }
function wc_get_order($id) { return $GLOBALS['orders'][$id] ?? false; }
function wp_next_scheduled($event, $args) { return $GLOBALS['scheduled'][$args[0]] ?? false; }
function wp_schedule_single_event($at, $event, $args) { $GLOBALS['scheduled'][$args[0]] = $at; }
class WC_Order_Item_Product {
    public function __construct(public $qty, public $original=0) {}
    public function get_quantity() { return $this->qty; }
    public function get_meta($key) { return $this->original; }
}
class WC_Order {
    public $meta=[]; public $notes=[]; public $items=[]; public $refunds=[];
    public function __construct(public $id) {}
    public function get_id() { return $this->id; }
    public function get_meta($key) { return $this->meta[$key] ?? ''; }
    public function update_meta_data($key,$value) { $this->meta[$key]=$value; }
    public function delete_meta_data($key) { unset($this->meta[$key]); }
    public function save() {}
    public function get_items() { return $this->items; }
    public function add_order_note($note) { $this->notes[]=$note; }
    public function get_refunds() { return $this->refunds; }
}
class WC_Order_Refund extends WC_Order {
    public $parent=100; public $amount=22000; public $shipping=-2000;
    public function get_parent_id() { return $this->parent; }
    public function get_amount() { return $this->amount; }
    public function get_shipping_total() { return $this->shipping; }
}
class LMC_Client {
    public static $calls=[]; public static $result;
    public static function post($url,$payload) { self::$calls[]=[$url,$payload]; return self::$result; }
    public static function is_retryable($error) { return $error->get_error_code()==='temporary'; }
}
require __DIR__.'/../labelmod-connector/includes/class-lmc-order-sync.php';
require __DIR__.'/../labelmod-connector/includes/class-lmc-refund-sync.php';
$n=0;
function check($actual,$expected,$label) {
    global $n; $n++;
    if ($actual !== $expected) { fwrite(STDERR,"FAIL $label: ".json_encode($actual)."\n"); exit(1); }
}
$order=new WC_Order(100); $order->items=[501=>new WC_Order_Item_Product(2),502=>new WC_Order_Item_Product(1)];
$order->meta[LMC_Order_Sync::META_PAYLOAD]=['externalId'=>'100','lines'=>[['sku'=>'ORIGINAL','qty'=>'2','unitPrice'=>'200000']]];
$order->meta[LMC_Order_Sync::META_LINES]=[501=>1,502=>2];
$refund=new WC_Order_Refund(101); $refund->items=[900=>new WC_Order_Item_Product(-1,501)];
$order->refunds=[$refund]; $GLOBALS['orders']=[100=>$order,101=>$refund]; $GLOBALS['scheduled']=[];
LMC_Refund_Sync::created(101,['restock_items'=>true]);
$payload=$refund->get_meta(LMC_Refund_Sync::PAYLOAD);
check($payload['orderId'],'100','original order identity');
check($payload['refundId'],'101','stable refund identity');
check($payload['amount'],'220000','toman converted to rial');
check($payload['shippingAmount'],'20000','negative Woo shipping becomes positive return');
check($payload['lines'],[['lineNo'=>1,'qty'=>'1','restock'=>true]],'original line and restock');
check(count($GLOBALS['scheduled']),1,'durable scheduled delivery');
$GLOBALS['scheduled']=[];
LMC_Refund_Sync::send(101);
check(count(LMC_Client::$calls),0,'original order must arrive first');
check(count($GLOBALS['scheduled']),1,'pending original retries');
$order->meta[LMC_Order_Sync::META_INVOICE]='invoice';
LMC_Client::$result=new WP_Error('temporary','network timeout'); $GLOBALS['scheduled']=[];
LMC_Refund_Sync::send(101);
check(count($GLOBALS['scheduled']),1,'temporary response retries');
check($refund->get_meta(LMC_Refund_Sync::DONE),'','failure never marked done');
$order->items=[]; // Frozen payload survives later edits to the Woo order.
LMC_Client::$result=['returnId'=>'ret-1','status'=>'posted','number'=>'R-1'];
LMC_Refund_Sync::send(101);
check(LMC_Client::$calls[1][1],$payload,'retry uses the original immutable event payload');
check($refund->get_meta(LMC_Refund_Sync::DONE),'ret-1','success saved');
check($refund->get_meta(LMC_Refund_Sync::ERROR),'','error cleared only on success');
LMC_Refund_Sync::send(101);
check(count(LMC_Client::$calls),2,'completed refund is not resent');
$order->items=[501=>new WC_Order_Item_Product(2)];
$refund2=new WC_Order_Refund(102); $refund2->items=[new WC_Order_Item_Product(-1,501)];
$order->items=[502=>new WC_Order_Item_Product(1),501=>new WC_Order_Item_Product(2)];
$GLOBALS['orders'][102]=$refund2;
LMC_Refund_Sync::created(102,['restock_items'=>false]);
check($refund2->get_meta(LMC_Refund_Sync::PAYLOAD)['lines'][0]['restock'],false,'do not invent stock on non-restocked refund');
check($refund2->get_meta(LMC_Refund_Sync::PAYLOAD)['lines'][0]['lineNo'],1,'reordered Woo items retain original invoice line');
$refund2->items=[];
check(is_wp_error(LMC_Refund_Sync::build_payload($order,$refund2)),true,'amount-only refund requires explicit manual accounting');
$refund2->items=[new WC_Order_Item_Product(-1,999)];
check(is_wp_error(LMC_Refund_Sync::build_payload($order,$refund2)),true,'unknown original item rejected');
LMC_Client::$result=new WP_Error('permanent','amount mismatch'); $GLOBALS['scheduled']=[];
LMC_Refund_Sync::send(102);
check(count($GLOBALS['scheduled']),0,'permanent accounting mismatch not retried blindly');
check($refund2->get_meta(LMC_Refund_Sync::DONE),'','mismatch is not successful');
$legacy=new WC_Order(200); $legacy->meta[LMC_Order_Sync::META_INVOICE]='old-invoice';
check(is_wp_error(LMC_Refund_Sync::build_payload($legacy,$refund2)),true,'legacy mapping is never guessed');

$pending=new WC_Order_Refund(103); $pending->items=[new WC_Order_Item_Product(-1,501)];
$GLOBALS['orders'][103]=$pending; $order->refunds[]=$pending;
LMC_Refund_Sync::created(103,['restock_items'=>true]);
$frozen=$pending->get_meta(LMC_Refund_Sync::PAYLOAD);
LMC_Client::$result=['requestId'=>'request-1','status'=>'pending'];
for ($i=0;$i<LMC_Order_Sync::MAX_ATTEMPTS+2;$i++) {
    $GLOBALS['scheduled']=[];
    LMC_Refund_Sync::send(103);
    check($pending->get_meta(LMC_Refund_Sync::DONE),'','pending does not claim a posted return');
    check(isset($GLOBALS['scheduled'][103]),true,'pending keeps polling beyond delivery retry limit');
}
check($pending->get_meta(LMC_Refund_Sync::REQUEST),'request-1','pending request identity saved');
check($pending->get_meta(LMC_Refund_Sync::PAYLOAD),$frozen,'pending poll preserves original payload');
$GLOBALS['scheduled']=[];
LMC_Client::$result=['requestId'=>'request-1','status'=>'rejected','reason'=>'invalid evidence'];
LMC_Refund_Sync::send(103);
check($pending->get_meta(LMC_Refund_Sync::STATUS),'rejected','rejection saved');
check($pending->get_meta(LMC_Refund_Sync::DONE),'','rejection never claims posted');
check(isset($GLOBALS['scheduled'][103]),false,'rejection is terminal');
$calls=count(LMC_Client::$calls);
LMC_Refund_Sync::send(103); LMC_Refund_Sync::retry_order($order);
check(count(LMC_Client::$calls),$calls,'rejected request is never silently resubmitted');
check(isset($GLOBALS['scheduled'][103]),false,'manual bulk retry does not reopen rejection');

$accepted=new WC_Order_Refund(104); $accepted->items=[new WC_Order_Item_Product(-1,501)];
$GLOBALS['orders'][104]=$accepted;
LMC_Refund_Sync::created(104,['restock_items'=>false]);
LMC_Client::$result=['requestId'=>'request-2','status'=>'pending'];
LMC_Refund_Sync::send(104);
LMC_Client::$result=['requestId'=>'request-2','returnId'=>'ret-approved','status'=>'posted','number'=>'R-approved'];
LMC_Refund_Sync::send(104);
check($accepted->get_meta(LMC_Refund_Sync::DONE),'ret-approved','only approval records the financial return');
check($accepted->get_meta(LMC_Refund_Sync::STATUS),'approved','final decision saved');
echo "PASS $n refund integration assertions\n";
