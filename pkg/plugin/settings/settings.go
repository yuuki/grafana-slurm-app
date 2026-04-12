package settings

import (
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/url"
	"slices"
	"strings"

	"github.com/go-sql-driver/mysql"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

type MetricsType string

const (
	MetricsTypePrometheus      MetricsType = "prometheus"
	MetricsTypeVictoriaMetrics MetricsType = "victoriametrics"
)

type NodeMatcherMode string

const (
	NodeMatcherHostPort NodeMatcherMode = "host:port"
	NodeMatcherHostname NodeMatcherMode = "hostname"
)

type AccessRule struct {
	AllowedRoles []string `json:"allowedRoles"`
	AllowedUsers []string `json:"allowedUsers,omitempty"`
}

func (r AccessRule) AllowsRole(role string) bool {
	if len(r.AllowedRoles) == 0 {
		return true
	}
	return slices.Contains(r.AllowedRoles, role)
}

func (r AccessRule) AllowsUser(login string) bool {
	if len(r.AllowedUsers) == 0 {
		return true
	}
	return slices.Contains(r.AllowedUsers, login)
}

type ConnectionProfile struct {
	ID                string `json:"id"`
	DBHost            string `json:"dbHost"`
	DBName            string `json:"dbName"`
	DBUser            string `json:"dbUser"`
	SecurePasswordRef string `json:"securePasswordRef"`
	Password          string `json:"-"`
}

func (c *ConnectionProfile) Defaults() {
	if c.DBName == "" {
		c.DBName = "slurm_acct_db"
	}
}

func (c ConnectionProfile) DSN() string {
	return buildDSN(c.DBUser, c.Password, c.DBHost, c.DBName)
}

type ClusterProfile struct {
	ID                    string          `json:"id"`
	DisplayName           string          `json:"displayName"`
	ConnectionID          string          `json:"connectionId"`
	SlurmClusterName      string          `json:"slurmClusterName"`
	MetricsDatasourceUID  string          `json:"metricsDatasourceUid"`
	MetricsType           MetricsType     `json:"metricsType"`
	AggregationNodeLabels []string        `json:"aggregationNodeLabels"`
	InstanceLabel         string          `json:"instanceLabel"`
	NodeMatcherMode       NodeMatcherMode `json:"nodeMatcherMode"`
	DefaultTemplateID     string          `json:"defaultTemplateId"`
	MetricsFilterLabel    string          `json:"metricsFilterLabel"`
	MetricsFilterValue    string          `json:"metricsFilterValue"`
	CPUUtilizationExpr    string          `json:"cpuUtilizationExpr"`
	GPUUtilizationExpr    string          `json:"gpuUtilizationExpr"`
	AccessRule            AccessRule      `json:"accessRule"`
}

func (c *ClusterProfile) Defaults() {
	if c.MetricsType == "" {
		c.MetricsType = MetricsTypePrometheus
	}
	if c.InstanceLabel == "" {
		c.InstanceLabel = "instance"
	}
	if len(c.AggregationNodeLabels) == 0 {
		c.AggregationNodeLabels = []string{"host.name", c.InstanceLabel}
	}
	c.AggregationNodeLabels = dedupeStrings(c.AggregationNodeLabels)
	if c.NodeMatcherMode == "" {
		c.NodeMatcherMode = NodeMatcherHostPort
	}
	if c.DefaultTemplateID == "" {
		c.DefaultTemplateID = "overview"
	}
}

type MetricSifterParams struct {
	SearchMethod           string  `json:"searchMethod"`
	CostModel              string  `json:"costModel"`
	Penalty                any     `json:"penalty"`
	PenaltyAdjust          float64 `json:"penaltyAdjust"`
	Bandwidth              float64 `json:"bandwidth"`
	SegmentSelectionMethod string  `json:"segmentSelectionMethod"`
	NJobs                  int     `json:"nJobs"`
	WithoutSimpleFilter    bool    `json:"withoutSimpleFilter"`
}

func DefaultMetricSifterParams() *MetricSifterParams {
	return &MetricSifterParams{
		SearchMethod:           "pelt",
		CostModel:              "l2",
		Penalty:                "bic",
		PenaltyAdjust:          2,
		Bandwidth:              2.5,
		SegmentSelectionMethod: "weighted_max",
		NJobs:                  1,
		WithoutSimpleFilter:    false,
	}
}

func (p *MetricSifterParams) Clone() *MetricSifterParams {
	if p == nil {
		return DefaultMetricSifterParams()
	}

	clone := *p
	return &clone
}

func (p *MetricSifterParams) Defaults() {
	defaults := DefaultMetricSifterParams()
	if p.SearchMethod == "" {
		p.SearchMethod = defaults.SearchMethod
	}
	if p.CostModel == "" {
		p.CostModel = defaults.CostModel
	}
	if p.Penalty == nil {
		p.Penalty = defaults.Penalty
	}
	if p.PenaltyAdjust == 0 {
		p.PenaltyAdjust = defaults.PenaltyAdjust
	}
	if p.Bandwidth == 0 {
		p.Bandwidth = defaults.Bandwidth
	}
	if p.SegmentSelectionMethod == "" {
		p.SegmentSelectionMethod = defaults.SegmentSelectionMethod
	}
	if p.NJobs == 0 {
		p.NJobs = defaults.NJobs
	}
}

func (p *MetricSifterParams) Validate() error {
	if p == nil {
		return nil
	}

	if !slices.Contains([]string{"pelt", "binseg", "bottomup"}, p.SearchMethod) {
		return fmt.Errorf("metricsifter searchMethod must be one of pelt, binseg, bottomup")
	}
	if !slices.Contains([]string{"l1", "l2", "normal", "rbf", "linear", "clinear", "rank", "mahalanobis", "ar"}, p.CostModel) {
		return fmt.Errorf("metricsifter costModel must be a supported ruptures model")
	}
	switch penalty := p.Penalty.(type) {
	case string:
		if penalty != "aic" && penalty != "bic" {
			return fmt.Errorf("metricsifter penalty must be aic, bic, or a finite number")
		}
	case float64:
		if math.IsNaN(penalty) || math.IsInf(penalty, 0) {
			return fmt.Errorf("metricsifter penalty must be aic, bic, or a finite number")
		}
	default:
		return fmt.Errorf("metricsifter penalty must be aic, bic, or a finite number")
	}
	if p.PenaltyAdjust <= 0 || math.IsNaN(p.PenaltyAdjust) || math.IsInf(p.PenaltyAdjust, 0) {
		return fmt.Errorf("metricsifter penaltyAdjust must be greater than 0")
	}
	if p.Bandwidth <= 0 || math.IsNaN(p.Bandwidth) || math.IsInf(p.Bandwidth, 0) {
		return fmt.Errorf("metricsifter bandwidth must be greater than 0")
	}
	if !slices.Contains([]string{"weighted_max", "max"}, p.SegmentSelectionMethod) {
		return fmt.Errorf("metricsifter segmentSelectionMethod must be weighted_max or max")
	}
	if p.NJobs == 0 {
		return fmt.Errorf("metricsifter nJobs must not be 0")
	}

	return nil
}

type Settings struct {
	DBHost                    string              `json:"dbHost"`
	DBName                    string              `json:"dbName"`
	DBUser                    string              `json:"dbUser"`
	DBPassword                string              `json:"-"`
	ClusterName               string              `json:"clusterName"`
	PromDatasourceUID         string              `json:"promDatasourceUid"`
	InstanceLabel             string              `json:"instanceLabel"`
	MetricSifterServiceURL        string              `json:"metricsifterServiceUrl"`
	MetricSifterDefaultParams     *MetricSifterParams `json:"metricsifterDefaultParams"`
	MetricSifterFilterGranularity string              `json:"metricsifterFilterGranularity"`
	Connections                   []ConnectionProfile `json:"connections"`
	Clusters                      []ClusterProfile    `json:"clusters"`
}

func (s *Settings) Defaults() {
	if s.InstanceLabel == "" {
		s.InstanceLabel = "instance"
	}
	if s.DBName == "" {
		s.DBName = "slurm_acct_db"
	}
	if s.MetricSifterFilterGranularity == "" {
		s.MetricSifterFilterGranularity = "disaggregated"
	}
	if s.MetricSifterDefaultParams != nil {
		s.MetricSifterDefaultParams.Defaults()
	}
	for idx := range s.Connections {
		s.Connections[idx].Defaults()
	}
	for idx := range s.Clusters {
		s.Clusters[idx].Defaults()
	}
}

func (s *Settings) EffectiveMetricSifterParams() *MetricSifterParams {
	if s != nil && s.MetricSifterDefaultParams != nil {
		return s.MetricSifterDefaultParams.Clone()
	}
	return DefaultMetricSifterParams()
}

func Parse(appSettings backend.AppInstanceSettings) (*Settings, error) {
	var s Settings
	if appSettings.JSONData != nil && len(appSettings.JSONData) > 0 {
		if err := json.Unmarshal(appSettings.JSONData, &s); err != nil {
			return nil, fmt.Errorf("failed to parse settings: %w", err)
		}
	}

	if pw, ok := appSettings.DecryptedSecureJSONData["dbPassword"]; ok {
		s.DBPassword = pw
	}

	// Apply defaults before validation so partially specified settings payloads
	// are normalized into the effective configuration shape first.
	s.Defaults()
	for idx := range s.Connections {
		ref := s.Connections[idx].SecurePasswordRef
		if ref == "" {
			continue
		}
		s.Connections[idx].Password = appSettings.DecryptedSecureJSONData[ref]
	}
	if err := s.applyLegacyDefaults(); err != nil {
		return nil, err
	}
	if err := s.Validate(); err != nil {
		return nil, err
	}
	return &s, nil
}

func buildDSN(user, password, host, dbName string) string {
	h, p, err := net.SplitHostPort(host)
	if err != nil {
		h = host
		p = "3306"
	}
	cfg := mysql.NewConfig()
	cfg.User = user
	cfg.Passwd = password
	cfg.Net = "tcp"
	cfg.Addr = net.JoinHostPort(h, p)
	cfg.DBName = dbName
	cfg.ParseTime = true
	cfg.Params = map[string]string{"charset": "utf8mb4"}
	return cfg.FormatDSN()
}

func dedupeStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func (s *Settings) applyLegacyDefaults() error {
	if len(s.Connections) > 0 || len(s.Clusters) > 0 {
		return nil
	}
	if s.DBHost == "" {
		return nil
	}
	s.Connections = []ConnectionProfile{
		{
			ID:       "default",
			DBHost:   s.DBHost,
			DBName:   s.DBName,
			DBUser:   s.DBUser,
			Password: s.DBPassword,
		},
	}
	s.Clusters = []ClusterProfile{
		{
			ID:                   s.ClusterName,
			DisplayName:          s.ClusterName,
			ConnectionID:         "default",
			SlurmClusterName:     s.ClusterName,
			MetricsDatasourceUID: s.PromDatasourceUID,
			InstanceLabel:        s.InstanceLabel,
			NodeMatcherMode:      NodeMatcherHostPort,
			DefaultTemplateID:    "overview",
		},
	}
	s.Defaults()
	return nil
}

func (s *Settings) Validate() error {
	if strings.TrimSpace(s.MetricSifterServiceURL) != "" {
		parsedURL, err := url.Parse(s.MetricSifterServiceURL)
		if err != nil || parsedURL.Host == "" || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") {
			return fmt.Errorf("metricsifterServiceUrl must be an absolute http or https URL")
		}
	}
	if s.MetricSifterDefaultParams != nil {
		if err := s.MetricSifterDefaultParams.Validate(); err != nil {
			return err
		}
	}
	if s.MetricSifterFilterGranularity != "disaggregated" && s.MetricSifterFilterGranularity != "aggregated" {
		return fmt.Errorf("metricsifterFilterGranularity must be disaggregated or aggregated")
	}

	connectionIDs := map[string]struct{}{}
	for _, connection := range s.Connections {
		if connection.ID == "" {
			return fmt.Errorf("connection id is required")
		}
		if _, exists := connectionIDs[connection.ID]; exists {
			return fmt.Errorf("duplicate connection id: %s", connection.ID)
		}
		connectionIDs[connection.ID] = struct{}{}
	}

	clusterIDs := map[string]struct{}{}
	for _, cluster := range s.Clusters {
		if cluster.ID == "" {
			return fmt.Errorf("cluster id is required")
		}
		if cluster.SlurmClusterName == "" {
			return fmt.Errorf("cluster %s missing slurmClusterName", cluster.ID)
		}
		if _, exists := clusterIDs[cluster.ID]; exists {
			return fmt.Errorf("duplicate cluster id: %s", cluster.ID)
		}
		clusterIDs[cluster.ID] = struct{}{}
		if cluster.ConnectionID != "" {
			if _, ok := connectionIDs[cluster.ConnectionID]; !ok {
				return fmt.Errorf("cluster %s references unknown connection %s", cluster.ID, cluster.ConnectionID)
			}
		}
	}
	return nil
}
