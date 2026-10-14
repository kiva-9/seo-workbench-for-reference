// 只消费当前 HTML 携带的已验证身份，不将它存入持久缓存。
export function takeBootstrappedUser(document) {
  const node=document.getElementById('app-bootstrap');
  if(!node)return null;
  node.remove();
  try {
    const user=JSON.parse(node.textContent).user;
    if(!Number.isSafeInteger(user?.id)||user.id<1||typeof user.email!=='string'||!['admin','member'].includes(user.role))return null;
    return user;
  }catch{return null;}
}
