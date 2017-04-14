define('workflow/wf-web-analytics',[
    'ui.api.v1'
  ],
  function(UiApi) {
    var LocalModel = UiApi.LocalModel;
    var Root = UiApi.Root;

    var WebAnalyticsFlow = {};

    function startRefreshTimer (timeout, webAnalyticsModel) {
      setTimeout(function () {
        webAnalyticsModel.refreshAccessToken().then(function () {
          startRefreshTimer(timeout);
        });
      }, timeout);
    }

    var webAnalyticsData = new LocalModel({
      name: 'webAnalyticsData',
      version: '0.01',
      attributes: {
        token: {default: null, persistence: LocalModel.Persistence.None},
        expiresInSec: {default: null, persistence: LocalModel.Persistence.None}
      }
    });

    var fetchPromise = null;

    webAnalyticsData.fetch = function () {

      var webAnalyticsModel = Root.Agent(Five9.Context.AgentId).WebAnalytics();
      var permissionsModel = Root.Agent(Five9.Context.AgentId).Permissions();

      if (fetchPromise) {
        return fetchPromise;
      }
      fetchPromise = $.when(webAnalyticsModel.fetch(), permissionsModel.fetch()).then(function (webAnalyticsResult) {
        if (webAnalyticsModel.get('token') === null){
          return webAnalyticsModel.refreshAccessToken().fail(function (jqXHR) {
            jqXHR.disableFive9GlobalHandler = true;
          });
        }
        return {
          attrs: webAnalyticsModel.attributes
        };
      }).then(null, function () {
        var licenseType;
        //if (permissionsModel.isAllowed(PermissionsConstants.WebAnalytics)) {
        if (permissionsModel.isAllowed('CAN_USE_WEB_ANALYTICS')) {
          licenseType = 'FULL';
        } else {
          licenseType = 'LIMITED';
        }
        return webAnalyticsModel.createAccessToken(licenseType);
      }).then(function (response) {
        startRefreshTimer((response.attrs.expiresInSec - 60) * 1000, webAnalyticsModel);
        webAnalyticsModel.set(response.attrs);
        webAnalyticsData.set({
          token: response.attrs.token,
          type: response.attrs.type
        });
      });

      return fetchPromise;
    };

    WebAnalyticsFlow.start = function () {
      return webAnalyticsData.fetch();
    };

    WebAnalyticsFlow.getModel = function () {
      return webAnalyticsData;
    };

    return WebAnalyticsFlow;
  });


define('workflow/altocloud.wrapper',[
    'workflow/wf-web-analytics'
  ],
  function(WebAnalyticsFlow) {
    var Alto = {};

    Alto.clientDeffered = null;

    Alto._getClient = function() {
      if (this.clientDeffered) {
        return this.clientDeffered.promise();
      }
      var self = this;

      this.clientDeffered = $.Deferred();
      var analytics = WebAnalyticsFlow.getModel();
      analytics.fetch().done(function() {
        self.clientDeffered.resolve(altocloud.createClient({accessToken: analytics.get('token')}));
      });
      return this.clientDeffered.promise();
    };

    Alto.customerIdByVisitId = function(shortVisitId) {
      var d = $.Deferred();
      this._getClient().done(function(client) {
        client.visits.findOne(shortVisitId).then(function(visit) {
          d.resolve(visit.customer);
        });
      });
      return d.promise();
    };

    Alto.customerVisits = function(customerId) {
      var d = $.Deferred();
      this._getClient().done(function(client) {
        client.visits.findByCustomer(customerId).then(function(visits) {
          d.resolve(visits);
        });
      });
      return d.promise();
    };

    Alto.Utils = {};

    Alto.Utils.generateAltocloudUrl = function (type, accessToken, visitId) {
      var altoUrl, cssUrl;
      var baseUrl = $('base').prop('href').replace(/\/[\w%\.\?=&\-]*$/g, '/');
      switch (type) {
        case 'side-frame':
          cssUrl = baseUrl + 'css/altocloud-side.css';
          altoUrl = 'customer-composite';
          break;
        case 'customer-journey':
          altoUrl = 'customer-journey';
          cssUrl = baseUrl + 'css/altocloud-journey.css';
          break;
        default:
          console.debug('Unknown altocloud type: ' + type);
      }

      if (visitId){
        var altoCloudBaseUrl = 'https://app.altocloud.com/gadgets';
        //return Utils.formatString(altoCloudBaseUrl + '/{0}/?visitId={1}&accessToken={2}&css={3}', altoUrl, visitId, accessToken, cssUrl);
        return altoCloudBaseUrl + '/' + altoUrl + '/?visitId=' + visitId + '&accessToken=' + accessToken + '&css=' + cssUrl;
      } else {
        return '';
      }
    };

    return Alto;
  });
define('workflow/init',[
  'ui.api.v1',
  'workflow/wf-web-analytics',
  'workflow/altocloud.wrapper'
],
function(UiApi, WebAnalyticsFlow, AltocloudWrapper) {
  return {
    initialize: function() {
      //Place your library initialization code here
    },

    joinCavMetadata: function(mapIdValue, metadataCollection) {
      var result = [];
      for (var id in mapIdValue) {
        //(value, id) {
        if (!mapIdValue.hasOwnProperty(id)) continue;
        var value = mapIdValue[id];
        var model = metadataCollection.get(id);
        if (model) {
          var metadataObj = model.toJSON();
          metadataObj.value = value;
          result.push(metadataObj);
        }
        else {
          console.error('joinMetadata: failed to find model for pair: ', value, id);
        }
      }

      return result;
    },

    getCavValue: function (cavList, cavName, cavGroup) {
      cavGroup = cavGroup.toLowerCase();
      cavName = cavName.toLowerCase();
      var cav = _.find(cavList, function (cav){
        return cav.name.toLowerCase() === cavName && cav.group.toLowerCase() === cavGroup;
      });
      if (!cav) {
        return null;
      }
      return cav.value;
    },

    getWebVisitId: function(callModel) {
      var cavs = callModel.get('variables') ? callModel.get('variables') : {};
      var cavList = this.joinCavMetadata(cavs, this.cavModel);
      return this.getCavValue(cavList, 'webVisitId', 'Altocloud');
    },

    computeJourneyUrl: function (visitId) {
      var accessToken = this.webAnalytics.get('token');
      return  AltocloudWrapper.Utils.generateAltocloudUrl('customer-journey', accessToken, visitId);
    },

    onModelLoad: function() {
      this.webAnalytics = WebAnalyticsFlow.getModel();
      this.cavModel = UiApi.Root.Tenant(Five9.Context.TenantId).CallVariables();

      var self = this;

      $.when(this.webAnalytics.fetch(), this.cavModel.fetch()).then(function () {
        /*
        var CrmApi = require('crm.api');
        CrmApi.search = function () {

        };
        */

        UiApi.Root.Agent(Five9.Context.AgentId).Calls().on('add', (function (model) {
          var visitId = self.getWebVisitId(model);
          if (visitId) {
            var altoJourneyUrl = self.computeJourneyUrl(visitId);
            window.open(altoJourneyUrl, 'altocloudJourney', 'width=800,height=500');
          }

        }));
      });

    },

    onModelUnload: function() {
      //Place your cleanup code here
    }
  };
});

define('3rdparty.bundle',[
    'ui.api.v1',
    'handlebars',
    'workflow/init'

    //presentations models

    //components

  ],
  function (UiApi, Handlebars, Init
) {



    require.config({
      map: {
        '*': {
        }
      }
    });


    Init.initialize();
    UiApi.vent.on(UiApi.PresModelEvents.WfMainOnModelLoad, function() {
      Init.onModelLoad();
    });
    UiApi.vent.on(UiApi.PresModelEvents.WfMainOnModelUnload, function() {
      Init.onModelUnload();
    });
  });

