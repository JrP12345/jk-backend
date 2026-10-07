import type { FastifyRequest, FastifyReply } from "fastify";
import { SiteVisit } from "../models/SiteVisit.ts";
import { Location } from "../models/Location.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

export async function getSiteTrafficAnalytics(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { days = "14" } = req.query as { days?: string };
    const numDays = Math.min(Math.max(parseInt(days, 10) || 14, 1), 60);

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    const yesterdayDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayStr = yesterdayDate.toISOString().slice(0, 10);

    const sevenDaysAgoDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const sevenDaysAgoStr = sevenDaysAgoDate.toISOString().slice(0, 10);

    const thirtyDaysAgoDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgoStr = thirtyDaysAgoDate.toISOString().slice(0, 10);

    const windowStartDate = new Date(now.getTime() - numDays * 24 * 60 * 60 * 1000);
    const windowStartStr = windowStartDate.toISOString().slice(0, 10);

    // 1. Headline Metrics
    const [
      todayCount,
      todayUnique,
      yesterdayCount,
      yesterdayUnique,
      sevenDayCount,
      thirtyDayCount,
      totalAllTime,
    ] = await Promise.all([
      SiteVisit.countDocuments({ date: todayStr }),
      SiteVisit.distinct("visitorId", { date: todayStr }).then((res) => res.length),
      SiteVisit.countDocuments({ date: yesterdayStr }),
      SiteVisit.distinct("visitorId", { date: yesterdayStr }).then((res) => res.length),
      SiteVisit.countDocuments({ date: { $gte: sevenDaysAgoStr } }),
      SiteVisit.countDocuments({ date: { $gte: thirtyDaysAgoStr } }),
      SiteVisit.estimatedDocumentCount(),
    ]);

    // 2. Daily Trends over requested window
    const dailyAgg = await SiteVisit.aggregate([
      { $match: { date: { $gte: windowStartStr } } },
      {
        $group: {
          _id: "$date",
          visits: { $sum: 1 },
          visitors: { $addToSet: { $ifNull: ["$visitorId", "$ipAddress"] } },
        },
      },
      {
        $project: {
          date: "$_id",
          visits: 1,
          uniqueVisitors: { $size: "$visitors" },
        },
      },
      { $sort: { date: 1 } },
    ]);

    // Ensure all days in the window are represented
    const dailyMap = new Map<string, { visits: number; uniqueVisitors: number }>();
    dailyAgg.forEach((item) => dailyMap.set(item.date, { visits: item.visits, uniqueVisitors: item.uniqueVisitors }));

    const dailyTrends = [];
    for (let i = numDays - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dStr = d.toISOString().slice(0, 10);
      const stat = dailyMap.get(dStr) || { visits: 0, uniqueVisitors: 0 };
      dailyTrends.push({
        date: dStr,
        visits: stat.visits,
        uniqueVisitors: stat.uniqueVisitors,
      });
    }

    // 3. Location Attribution Breakdown ("whose location and all")
    const locationVisitsAgg = await SiteVisit.aggregate([
      { $match: { date: { $gte: windowStartStr } } },
      {
        $group: {
          _id: "$locationId",
          visits: { $sum: 1 },
          visitors: { $addToSet: { $ifNull: ["$visitorId", "$ipAddress"] } },
        },
      },
      {
        $project: {
          locationId: "$_id",
          visits: 1,
          uniqueVisitors: { $size: "$visitors" },
        },
      },
      { $sort: { visits: -1 } },
    ]);

    // Fetch location documents to enrich with location name and organization name
    const locationIds = locationVisitsAgg.filter((c) => c.locationId).map((c) => c.locationId);
    const locations = await Location.find({ _id: { $in: locationIds } })
      .populate("organizationId", "name city")
      .lean();
    const locationMap = new Map<string, any>();
    locations.forEach((c: any) => locationMap.set(c._id.toString(), c));

    const totalWindowVisits = dailyTrends.reduce((acc, cur) => acc + cur.visits, 0) || 1;

    const locationAttribution = locationVisitsAgg.map((item) => {
      if (!item.locationId) {
        return {
          locationId: null,
          locationName: "General Platform / Portal",
          organizationName: "Direct Visitors",
          city: "Global",
          visits: item.visits,
          uniqueVisitors: item.uniqueVisitors,
          percentShare: Number(((item.visits / totalWindowVisits) * 100).toFixed(1)),
        };
      }
      const locationObj = locationMap.get(item.locationId.toString());
      const org = locationObj?.organizationId as any;
      return {
        locationId: item.locationId.toString(),
        locationName: locationObj ? locationObj.name : "Archived Location",
        organizationName: org ? org.name : "Platform Tenant",
        city: locationObj ? locationObj.city : "Unknown",
        visits: item.visits,
        uniqueVisitors: item.uniqueVisitors,
        percentShare: Number(((item.visits / totalWindowVisits) * 100).toFixed(1)),
      };
    });

    // 4. Top Landing Pages
    const topPagesAgg = await SiteVisit.aggregate([
      { $match: { date: { $gte: windowStartStr } } },
      { $group: { _id: "$path", visits: { $sum: 1 } } },
      { $sort: { visits: -1 } },
      { $limit: 10 },
      { $project: { path: "$_id", visits: 1, _id: 0 } },
    ]);

    // 5. Device & Browser distribution
    const [devicesAgg, browsersAgg] = await Promise.all([
      SiteVisit.aggregate([
        { $match: { date: { $gte: windowStartStr } } },
        { $group: { _id: "$device", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      SiteVisit.aggregate([
        { $match: { date: { $gte: windowStartStr } } },
        { $group: { _id: "$browser", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);

    const summary = {
      todayVisits: todayCount,
      todayVisitors: todayUnique,
      yesterdayVisits: yesterdayCount,
      yesterdayVisitors: yesterdayUnique,
      sevenDayVisits: sevenDayCount,
      thirtyDayVisits: thirtyDayCount,
      totalVisits: totalAllTime,
    };

    return reply.send(
      successResponse(
        {
          summary,
          dailyTrends,
          locationAttribution,
          topPages: topPagesAgg,
          devices: devicesAgg.map((d) => ({ name: d._id || "Desktop", count: d.count })),
          browsers: browsersAgg.map((b) => ({ name: b._id || "Other", count: b.count })),
        },
        "Site traffic analytics retrieved"
      )
    );
  } catch (err: any) {
    console.error("getSiteTrafficAnalytics error:", err);
    return reply.code(500).send(errorResponse("Failed to fetch traffic analytics"));
  }
}
