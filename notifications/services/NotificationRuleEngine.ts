import type { DomainEventPayload } from "../../events/types.ts";

export interface RoutingRule {
  ruleName: string;
  category?: string;
  severity?: string;
  priority?: string;
  channels: {
    inApp: boolean;
    email: boolean;
  };
}

class NotificationRuleEngineManager {
  private defaultRules: RoutingRule[] = [
    {
      ruleName: "Critical Escalation Rule",
      severity: "error",
      priority: "urgent",
      channels: {
        inApp: true,
        email: true,
      },
    },
    {
      ruleName: "Security Alert Rule",
      category: "security",
      channels: {
        inApp: true,
        email: true,
      },
    },
    {
      ruleName: "Standard System Event Rule",
      category: "system",
      channels: {
        inApp: true,
        email: false,
      },
    },
  ];

  /**
   * Evaluate routing channels based on event severity, category, and priority
   */
  public evaluateRouting(event: DomainEventPayload, userPreferencesChannels: any) {
    let effectiveChannels = {
      inApp: userPreferencesChannels?.inApp !== false,
      email: userPreferencesChannels?.email === true,
    };

    // Find matching rule override
    const matchingRule = this.defaultRules.find((rule) => {
      if (rule.severity && rule.severity !== event.severity) return false;
      if (rule.priority && rule.priority !== event.priority) return false;
      if (rule.category && rule.category !== event.category) return false;
      return true;
    });

    if (matchingRule) {
      effectiveChannels = {
        inApp: effectiveChannels.inApp && matchingRule.channels.inApp,
        email: effectiveChannels.email || (matchingRule.channels.email && userPreferencesChannels?.email !== false),
      };
    }

    return effectiveChannels;
  }
}

export const notificationRuleEngine = new NotificationRuleEngineManager();
