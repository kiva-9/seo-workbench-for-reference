const { resourceHostname } = require('../lib/resource-domain');

function createResourceDiscovery({ getAccessToken, beforeRequest = () => {} }) {
  async function read(accountId,url) {
    const token = await getAccessToken(accountId);
    beforeRequest();
    const response = await fetch(url,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
    if (!response.ok) {
      const error = new Error(response.status===401||response.status===403 ? 'Google 权限不足，请检查授权和资源权限' : `Google 目录请求失败（${response.status}）`);
      error.transient = response.status===429||response.status>=500;
      throw error;
    }
    return response.json();
  }
  return {
    async discoverGscSites(accountId) {
      const data = await read(accountId,'https://www.googleapis.com/webmasters/v3/sites');
      return (data.siteEntry||[]).filter(s=>s.permissionLevel&&s.permissionLevel!=='siteUnverifiedUser').map(s=>({
        resource_key:s.siteUrl,display_name:s.siteUrl,permission_level:s.permissionLevel,
        domains:[{stream_key:s.siteUrl,stream_type:s.siteUrl.startsWith('sc-domain:')?'DOMAIN':'URL_PREFIX',website:s.siteUrl,hostname:resourceHostname(s.siteUrl)}],
      }));
    },
    async discoverGa4PropertiesPage(accountId,pageToken='') {
      const query = new URLSearchParams({pageSize:'200',...(pageToken?{pageToken}:{})});
      const data = await read(accountId,`https://analyticsadmin.googleapis.com/v1beta/accountSummaries?${query}`);
      const resources = (data.accountSummaries||[]).flatMap(a=>(a.propertySummaries||[]).map(p=>({
        resource_key:String(p.property||'').replace(/^properties\//,''),display_name:p.displayName||'',account_display_name:a.displayName||'',
      }))).filter(p=>/^\d+$/.test(p.resource_key));
      return {resources,nextPageToken:data.nextPageToken||''};
    },
    async discoverGa4StreamsPage(accountId,propertyId,pageToken='') {
      if (!/^\d+$/.test(String(propertyId))) throw new Error('GA4 资源 ID 无效');
      const query = new URLSearchParams({pageSize:'200',...(pageToken?{pageToken}:{})});
      const data = await read(accountId,`https://analyticsadmin.googleapis.com/v1beta/properties/${propertyId}/dataStreams?${query}`);
      const streams = (data.dataStreams||[]).map(s=>({stream_key:s.name,stream_type:s.type||'',
        website:s.type==='WEB_DATA_STREAM'?(s.webStreamData?.defaultUri||''):'',
        hostname:s.type==='WEB_DATA_STREAM'?resourceHostname(s.webStreamData?.defaultUri):'',
      })).filter(s=>s.stream_key);
      return {streams,nextPageToken:data.nextPageToken||''};
    },
  };
}
module.exports = {createResourceDiscovery};
